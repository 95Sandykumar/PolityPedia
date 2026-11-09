/**
 * No second order while a payment is pending
 * (issue 61-block-second-order, migration 0049).
 *
 * THE GAP (walk persona-3, gap 4). `start_set_purchase()` read "already
 * owned" out of `set_access` alone. A slow Razorpay confirmation leaves
 * `set_access` empty for a few seconds, so a student who taps Unlock twice
 * got TWO `purchases` rows and TWO Razorpay orders. If both get paid that is
 * a double charge and a refund ticket; even unpaid it is a row the nightly
 * reconcile (A6) has to explain.
 *
 * THE RULE. A `created` purchase for the same student and the same set, YOUNGER
 * THAN 15 MINUTES, refuses the next order with `PP425` and hands back the
 * pending Razorpay order id in the error DETAIL, so the UI can reopen the
 * checkout the student already has instead of opening a second one.
 *
 * WHY 15 MINUTES AND NOT FOREVER. An abandoned checkout must not lock a
 * student out of a set they still want to buy. Razorpay's own hosted checkout
 * session is short, so a `created` row older than 15 minutes is dead paperwork
 * and a fresh order is the right answer.
 *
 * WHAT MUST NOT MOVE (design constraints A1 to A6): this function still never
 * sets a purchase to `paid`, never writes `teacher_ledger`, and still quotes
 * the price from `mock_sets` (F-G2). The sign-in, live-set, own-set, owned and
 * coupon refusals keep their codes and their order, and a refusal spends no
 * coupon use.
 *
 * Seed with `db.admin` (bypasses RLS), buy with `db.asUser` (every policy is
 * evaluated for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the set under test. */
let teacher: string;
/** The buyer. */
let student: string;
/** A second buyer, so one student's pending order cannot block another's. */
let other: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

let setId: string;

interface Started {
  purchase_id: string;
  amount_inr: number;
  status: string;
}

/** The SQLSTATE the new refusal raises. */
const PENDING = 'PP425';
/** The SQLSTATE "you already own this set" has raised since 0026. */
const OWNED = 'PP409';

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

/** Attach the Razorpay order id, the way the route does after the API call. */
function attachAs(actor: string, purchaseId: string, orderId: string) {
  return db.asUser(actor, async (sql) => {
    await sql.query('select public.attach_order_id($1, $2)', [purchaseId, orderId]);
  });
}

/** The SQLSTATE and the DETAIL a refusal carried. Both are part of the contract. */
async function refusal(run: Promise<unknown>): Promise<{ code: string; detail: string }> {
  try {
    await run;
  } catch (error) {
    const raised = error as { code?: string; detail?: string };
    return { code: raised.code ?? '', detail: raised.detail ?? '' };
  }
  throw new Error('expected a refusal, got an answer');
}

/** Make a purchase row look older than it is, so no test has to wait. */
function ageMinutes(purchaseId: string, minutes: number) {
  return db.admin.query(
    `update public.purchases
     set created_at = now() - (interval '1 minute' * $2::integer)
     where id = $1`,
    [purchaseId, minutes],
  );
}

function purchaseRows() {
  return db.admin
    .query<{ id: string; status: string; amount_inr: number; set_id: string }>(
      'select id, status, amount_inr, set_id from public.purchases order by created_at',
    )
    .then((res) => res.rows);
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
  it('is applied in issue-number order', () => {
    expect(db.migrations).toContain('0049_block_second_order.sql');
  });
});

describe('a payment in progress blocks the second order', () => {
  it('refuses the second tap and writes no second purchase row', async () => {
    const first = await startAs(student, setId);
    expect(first.status).toBe('created');

    const refused = await refusal(startAs(student, setId));
    expect(refused.code).toBe(PENDING);

    // THE assertion of this slice: one purchase, so one Razorpay order.
    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.purchase_id);
    expect(rows[0].status).toBe('created');
  });

  it('hands back the pending order id, so the UI can reopen that checkout', async () => {
    const first = await startAs(student, setId);
    await attachAs(student, first.purchase_id, 'order_pending_1');

    const refused = await refusal(startAs(student, setId));
    expect(refused.code).toBe(PENDING);
    expect(refused.detail).toBe('order_pending_1');
  });

  it('still refuses before the order id has been attached', async () => {
    await startAs(student, setId);

    // The gap is widest HERE: the row exists, Razorpay has not answered yet,
    // so there is no order id to hand back. The refusal still has to happen.
    const refused = await refusal(startAs(student, setId));
    expect(refused.code).toBe(PENDING);
    expect(refused.detail).toBe('');
  });

  it('refuses a tap with a coupon too, and spends no coupon use', async () => {
    await db.admin.query(
      "insert into public.coupons (code, percent_off, max_uses) values ('HALF50', 50, 9)",
    );

    const first = await startAs(student, setId, 'HALF50');
    expect(first.amount_inr).toBe(200);

    const refused = await refusal(startAs(student, setId, 'HALF50'));
    expect(refused.code).toBe(PENDING);

    // A refused tap must not burn a code a real buyer could have used: only a
    // DONE sale spends one (0026).
    const used = await db.admin.query<{ used: number }>(
      "select used from public.coupons where code = 'HALF50'",
    );
    expect(used.rows[0].used).toBe(0);
  });

  it('still blocks at 14 minutes', async () => {
    const first = await startAs(student, setId);
    await ageMinutes(first.purchase_id, 14);

    const refused = await refusal(startAs(student, setId));
    expect(refused.code).toBe(PENDING);
  });
});

describe('an abandoned checkout does not lock the student out', () => {
  it('lets a new order through once the pending one is older than 15 minutes', async () => {
    const first = await startAs(student, setId);
    await ageMinutes(first.purchase_id, 16);

    const second = await startAs(student, setId);

    expect(second.status).toBe('created');
    expect(second.purchase_id).not.toBe(first.purchase_id);
    expect(second.amount_inr).toBe(399);

    const rows = await purchaseRows();
    expect(rows).toHaveLength(2);
    // The dead row is left exactly as it was: it is a receipt of an attempt.
    expect(rows.map((row) => row.status)).toEqual(['created', 'created']);
  });
});

describe('what the guard does not look at', () => {
  it('leaves a paid purchase alone and does not read it as pending', async () => {
    const first = await startAs(student, setId);
    await attachAs(student, first.purchase_id, 'order_paid_1');
    // What the webhook (0027) does, without the access row: a `paid` purchase
    // is finished business, so it is not a payment IN PROGRESS.
    await db.admin.query("update public.purchases set status = 'paid' where id = $1", [
      first.purchase_id,
    ]);

    const second = await startAs(student, setId);
    expect(second.status).toBe('created');

    const rows = await purchaseRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first.purchase_id);
    // A5: this function never rewrites a paid row and never touches money.
    expect(rows[0].status).toBe('paid');
    expect(rows[0].amount_inr).toBe(399);
  });

  it('ignores a refunded purchase', async () => {
    const first = await startAs(student, setId);
    await db.admin.query("update public.purchases set status = 'refunded' where id = $1", [
      first.purchase_id,
    ]);

    const second = await startAs(student, setId);
    expect(second.status).toBe('created');
    expect(second.purchase_id).not.toBe(first.purchase_id);
  });

  it('never lets one student block another', async () => {
    await startAs(student, setId);

    const theirs = await startAs(other, setId);
    expect(theirs.status).toBe('created');
  });

  it('never lets one set block another', async () => {
    const two = await insertSet({ title: 'Full length set 2' });
    await startAs(student, setId);

    const second = await startAs(student, two);
    expect(second.status).toBe('created');
  });
});

describe('the older refusals keep their codes', () => {
  it('says "already unlocked" and not "payment pending" for a set you own', async () => {
    const first = await startAs(student, setId);
    await db.admin.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'purchase', 'infinity')`,
      [student, setId],
    );
    expect(first.status).toBe('created');

    // Owned is the older, clearer answer: reload and start the test. The
    // pending check must not steal it.
    const refused = await refusal(startAs(student, setId));
    expect(refused.code).toBe(OWNED);
  });

  it('writes no ledger row and no money while it refuses (A5, A6)', async () => {
    await startAs(student, setId);
    await refusal(startAs(student, setId));

    const ledger = await db.admin.query('select 1 from public.teacher_ledger');
    expect(ledger.rows).toHaveLength(0);

    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('created');
  });
});
