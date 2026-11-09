/**
 * Two quick taps can both create a pending order
 * (issue 80-fix-double-tap-order-race, migration 0055).
 *
 * THE GAP TICKET 61 LEFT. 0049 refuses the second order by READING `purchases`
 * ("is there a `created` row for this student and this set, younger than 15
 * minutes?") and then INSERTING. Check-then-insert, with nothing in between.
 * Two requests that are truly at the same time both run the SELECT before
 * either runs the INSERT, both see "no pending row", and both insert. The
 * student gets two `purchases` rows and two Razorpay orders, which is the
 * double charge 61 was written to stop.
 *
 * WHY NOT A UNIQUE INDEX. 0049 already explains it: the rule is about TIME
 * (the same pair is allowed again once the old row is stale) and `now()` is not
 * immutable, so a partial unique index cannot express it. Nothing about that
 * changed, so the serialisation has to be a LOCK.
 *
 * THE FIX. `pg_advisory_xact_lock(hashtextextended(buyer::text || for_set::text, 0))`
 * immediately before the pending-order SELECT. The key is derived from the
 * buyer and the set and from nothing else, so:
 *   * two requests by the SAME student for the SAME set queue up, and the
 *     second one runs its SELECT only after the first has committed its
 *     INSERT, so it sees the pending row and refuses with PP425 as before,
 *   * two DIFFERENT students, or the same student on two different sets, hash
 *     to different keys and never wait for each other,
 *   * it is an `xact` lock, so COMMIT or ROLLBACK releases it and no request
 *     can leak a lock that blocks that student forever.
 *
 * WHAT THIS TEST CAN AND CANNOT DO. The harness is PGlite: ONE Postgres
 * backend, one connection, and `test/db.ts` serialises every `asUser` block
 * because the role and the JWT claim are session state. A second connection
 * that really waits on the lock is therefore not available here. So this file
 * proves the fix the three ways that ARE deterministic on one backend:
 *   1. the lock is actually taken while the function runs, and `pg_locks`
 *      shows the key is exactly `hashtextextended(buyer || set, 0)`,
 *   2. the lock is taken BEFORE the pending-order SELECT and AFTER the
 *      `set_access` check, which is the whole point: a lock taken after the
 *      read would leave the window open, and one taken earlier would change
 *      the refusal order,
 *   3. two taps fired together (not awaited one after the other) still leave
 *      exactly ONE pending order and one PP425.
 * Points 1 and 2 are the ones that fail without 0055.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, readMigrations, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the set under test. */
let teacher: string;
/** The buyer whose double tap this ticket is about. */
let student: string;
/** A second buyer, who must never wait behind the first one's lock. */
let other: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

let setId: string;

/** The SQLSTATE the pending refusal has raised since 0049. Unchanged here. */
const PENDING = 'PP425';

interface Started {
  purchase_id: string;
  amount_inr: number;
  status: string;
}

/** One advisory lock as `pg_locks` reports it, with the 64-bit key split in two. */
interface AdvisoryLock {
  classid: string;
  objid: string;
  objsubid: number;
  mode: string;
  granted: boolean;
}

async function insertSet(values: { price?: number; title?: string } = {}) {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, $4, 'live')
     returning id`,
    [teacher, NET, values.title ?? 'Full length set 1', values.price ?? 399],
  );
  return res.rows[0].id;
}

/** Buy, the way the route does: through RLS, as the student themselves. */
function startAs(actor: string, forSet: string, coupon: string | null = null) {
  return db.asUser(actor, async (sql) => {
    const res = await sql.query<Started>('select * from public.start_set_purchase($1, $2)', [
      forSet,
      coupon,
    ]);
    return res.rows[0];
  });
}

/**
 * `pg_advisory_xact_lock(bigint)` is reported by `pg_locks` with the high 32
 * bits of the key in `classid`, the low 32 in `objid`, and `objsubid` = 1.
 * Both halves come back as text, because a bigint does not survive JSON.
 */
function expectedKey(buyer: string, forSet: string) {
  return db.admin
    .query<{ classid: string; objid: string }>(
      `select ((hashtextextended($1::text || $2::text, 0) >> 32) & 4294967295)::text as classid,
              (hashtextextended($1::text || $2::text, 0) & 4294967295)::text as objid`,
      [buyer, forSet],
    )
    .then((res) => res.rows[0]);
}

/**
 * Call `start_set_purchase` inside an OPEN transaction and report the advisory
 * locks the backend holds at that moment, then roll the whole thing back.
 *
 * An `xact` lock lives exactly as long as its transaction, so this is the only
 * moment it can be observed: once the function returns under autocommit the
 * lock is already gone.
 */
function locksHeldDuring(actor: string, forSet: string) {
  return db.asUser(actor, async (sql) => {
    await sql.exec('begin');
    try {
      await sql.query('select * from public.start_set_purchase($1, $2)', [forSet, null]);
      const res = await sql.query<AdvisoryLock>(
        `select classid::text as classid, objid::text as objid, objsubid, mode, granted
         from pg_locks
         where locktype = 'advisory'`,
      );
      return res.rows;
    } finally {
      // ROLLBACK, so the probe leaves no purchase row behind, and so the test
      // also proves an abandoned transaction releases the lock.
      await sql.exec('rollback');
    }
  });
}

/** The body Postgres really stored, with `--` comments stripped so prose cannot match. */
async function functionBody(): Promise<string> {
  const res = await db.admin.query<{ src: string }>(
    `select pg_get_functiondef(p.oid) as src
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'start_set_purchase'`,
  );
  return res.rows[0].src
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function purchaseRows() {
  return db.admin
    .query<{ id: string; status: string; set_id: string }>(
      'select id, status, set_id from public.purchases order by created_at',
    )
    .then((res) => res.rows);
}

/** The SQLSTATE a rejected call carried. */
function codeOf(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return '';
  return (result.reason as { code?: string }).code ?? '';
}

/** The 64-bit key as one string, so two locks can be compared in one assertion. */
function keyOf(lock: { classid: string; objid: string }): string {
  return `${lock.classid}:${lock.objid}`;
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();
  other = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacher],
  );
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.teacher_ledger');
  await db.admin.query('delete from public.purchases');
  await db.admin.query('delete from public.coupons');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.mock_sets');
  setId = await insertSet({ price: 399 });
});

describe('the migration', () => {
  it('is applied after 0049', () => {
    expect(db.migrations).toContain('0055_order_race_lock.sql');
    expect(db.migrations.indexOf('0055_order_race_lock.sql')).toBeGreaterThan(
      db.migrations.indexOf('0049_block_second_order.sql'),
    );
  });

  it('leaves 0049 alone and puts the lock in 0055', async () => {
    const files = await readMigrations();
    const old = files.find((file) => file.name === '0049_block_second_order.sql');
    const next = files.find((file) => file.name === '0055_order_race_lock.sql');

    // 0049 is shipped history: the fix is a NEW file, never an edit of an
    // already applied migration.
    expect(old?.sql).not.toContain('pg_advisory_xact_lock');
    expect(next?.sql).toContain('pg_advisory_xact_lock');
  });
});

describe('the pending-order check holds a lock while it runs', () => {
  it('takes one exclusive transaction lock, keyed on the buyer and the set', async () => {
    const held = await locksHeldDuring(student, setId);

    // THE assertion of this slice. Without the lock the check-then-insert has
    // no gate at all, and two real connections both get a purchase row.
    expect(held).toHaveLength(1);
    expect(held[0].mode).toBe('ExclusiveLock');
    expect(held[0].granted).toBe(true);
    // objsubid 1 is the single-bigint form of an advisory lock, which is what
    // `pg_advisory_xact_lock(hashtextextended(...))` takes.
    expect(held[0].objsubid).toBe(1);

    expect(keyOf(held[0])).toBe(keyOf(await expectedKey(student, setId)));
  });

  it('releases it when the transaction ends, so nobody is locked out', async () => {
    await locksHeldDuring(student, setId);

    // `locksHeldDuring` rolls back. An xact lock dies with its transaction, so
    // an abandoned checkout cannot leave a lock behind.
    const after = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory'",
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('gives a different key to a different buyer, so one cannot block another', async () => {
    const mine = await locksHeldDuring(student, setId);
    const theirs = await locksHeldDuring(other, setId);

    expect(keyOf(theirs[0])).not.toBe(keyOf(mine[0]));
    expect(keyOf(theirs[0])).toBe(keyOf(await expectedKey(other, setId)));
  });

  it('gives a different key to a different set, so one set cannot block another', async () => {
    const two = await insertSet({ title: 'Full length set 2' });

    const first = await locksHeldDuring(student, setId);
    const second = await locksHeldDuring(student, two);

    expect(keyOf(second[0])).not.toBe(keyOf(first[0]));
    expect(keyOf(second[0])).toBe(keyOf(await expectedKey(student, two)));
  });
});

describe('where the lock sits in the function', () => {
  it('takes the lock BEFORE reading purchases', async () => {
    const body = await functionBody();

    const lock = body.indexOf('pg_advisory_xact_lock');
    const read = body.indexOf('from public.purchases');

    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    // A lock taken after the read is not a fix: both callers would already
    // have decided "no pending row" before either of them waits.
    expect(lock).toBeLessThan(read);
  });

  it('takes it AFTER the set_access check, so the refusal order is unchanged', async () => {
    const body = await functionBody();

    const owned = body.indexOf('from public.set_access');
    const lock = body.indexOf('pg_advisory_xact_lock');

    expect(owned).toBeGreaterThan(-1);
    // "You already own this" (PP409) is the better news and still comes first,
    // and an owned set must not make the caller queue for a lock at all.
    expect(owned).toBeLessThan(lock);
  });

  it('holds the lock across the insert, not just the read', async () => {
    const body = await functionBody();

    const lock = body.indexOf('pg_advisory_xact_lock');
    const insert = body.indexOf('insert into public.purchases');

    expect(insert).toBeGreaterThan(-1);
    // An xact lock is held until COMMIT, so the read AND the insert are inside
    // it. If the insert came first the lock would be guarding nothing.
    expect(lock).toBeLessThan(insert);
  });
});

describe('two taps at the same time', () => {
  it('produces exactly one pending order and one PP425', async () => {
    // Fired together, NOT awaited one after the other: neither call is given a
    // chance to finish before the other starts.
    const settled = await Promise.allSettled([startAs(student, setId), startAs(student, setId)]);

    const won = settled.filter((result) => result.status === 'fulfilled');
    const lost = settled.filter((result) => result.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser gets the SAME refusal a slow second tap got before, so the
    // student reads no new sentence.
    expect(codeOf(lost[0])).toBe(PENDING);

    // The definition of done: one pending order, so one Razorpay order.
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('created');
  });

  it('still lets two different students through at the same time', async () => {
    const settled = await Promise.allSettled([startAs(student, setId), startAs(other, setId)]);

    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await purchaseRows()).toHaveLength(2);
  });

  it('still lets one student buy two different sets at the same time', async () => {
    const two = await insertSet({ title: 'Full length set 2' });

    const settled = await Promise.allSettled([startAs(student, setId), startAs(student, two)]);

    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await purchaseRows()).map((row) => row.set_id).sort()).toEqual([setId, two].sort());
  });
});
