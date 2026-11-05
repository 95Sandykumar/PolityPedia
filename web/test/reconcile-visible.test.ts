/**
 * Who may READ and RESOLVE a money alert (issue 35-reconcile-visible).
 *
 * `0029_reconcile.sql` created `reconcile_alerts` with a `resolved_at` column
 * and an admin-only policy, and then nothing in the app ever opened the table.
 * `/admin/alerts` is the human end of it, so the policy has to be right in
 * BOTH directions now, not just for reading:
 *
 *  * an admin lists the open ones and sets `resolved_at`
 *  * a teacher and a student see nothing and can change nothing
 *
 * RLS is Postgres, never faked in JavaScript: seed with `db.admin`, assert
 * with `db.asUser` (web/CLAUDE.md).
 *
 * The fifth kind, `unreadable_purchase`, is also checked here. The nightly job
 * now files one alert when the purchases read dropped rows it could not parse,
 * and `reconcile_alerts_kind_check` has to accept it or that alert would be
 * lost at the exact moment the data got strange.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;
let adminUser: string;
let teacher: string;
let student: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

function alert(kind: string, subject: string) {
  return db.admin
    .query<{ fresh: boolean }>(
      'select public.record_reconcile_alert($1, $2, $3, $4, $5) as fresh',
      [kind, subject, 'order_' + subject, null, 39_900],
    )
    .then((r) => r.rows[0].fresh);
}

/** The id of one alert, read as the owner. */
function idOf(subject: string) {
  return db.admin
    .query<{ id: string }>('select id from public.reconcile_alerts where subject = $1', [subject])
    .then((r) => r.rows[0].id);
}

/** Exactly the read the page makes: open alerts, newest first. */
function listOpen(as: string) {
  return db.asUser(as, async (sql) => {
    const res = await sql.query<{ id: string; subject: string }>(
      `select id, subject from public.reconcile_alerts
       where resolved_at is null order by created_at desc`,
    );
    return res.rows;
  });
}

/** Exactly the write the Resolved button makes. Returns the rows it changed. */
function resolve(as: string, id: string) {
  return db.asUser(as, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `update public.reconcile_alerts
       set resolved_at = now()
       where id = $1 and resolved_at is null
       returning id`,
      [id],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  adminUser = await db.createUser();
  teacher = await db.createUser();
  student = await db.createUser();

  // `profiles_block_role_change` refuses a role change by anybody but an
  // admin, so the first admin is seeded as a fresh row, not an update.
  await db.admin.query('delete from public.profiles where id = $1', [adminUser]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [adminUser]);

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status, revenue_share_pct)
     values ($1, 'alias', 'Polity Guru', 'approved', 50)`,
    [teacher],
  );
  // Proves the teacher really is a teacher, so "a teacher sees nothing" is
  // about the policy and not about an unseeded fixture.
  await db.admin.query(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set', 399, 'live')`,
    [teacher, NET],
  );
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.reconcile_alerts');
});

describe('the migration', () => {
  it('is applied after 0029, which made the table', () => {
    expect(db.migrations).toContain('0035_reconcile_visible.sql');
    expect(db.migrations.indexOf('0035_reconcile_visible.sql')).toBeGreaterThan(
      db.migrations.indexOf('0029_reconcile.sql'),
    );
  });

  it('accepts the fifth kind, unreadable_purchase', async () => {
    await expect(alert('unreadable_purchase', 'purchases:2026-11-05')).resolves.toBe(true);
  });

  it('still refuses a kind that is not on the list', async () => {
    await expect(alert('no_purchse', 'pay_typo')).rejects.toThrow();
  });

  it('still de-dupes the fifth kind on (kind, subject)', async () => {
    await expect(alert('unreadable_purchase', 'purchases:2026-11-05')).resolves.toBe(true);
    await expect(alert('unreadable_purchase', 'purchases:2026-11-05')).resolves.toBe(false);
  });
});

describe('an admin', () => {
  beforeEach(async () => {
    await alert('no_purchase', 'pay_ghost');
    await alert('no_payment', 'order:order_given_away');
  });

  it('lists every open alert', async () => {
    const rows = await listOpen(adminUser);
    expect(rows.map((r) => r.subject).sort()).toEqual(['order:order_given_away', 'pay_ghost']);
  });

  it('resolves one, and it leaves the open list', async () => {
    const id = await idOf('pay_ghost');

    const changed = await resolve(adminUser, id);
    expect(changed).toHaveLength(1);

    const rows = await listOpen(adminUser);
    expect(rows.map((r) => r.subject)).toEqual(['order:order_given_away']);
  });

  it('changes nothing on a second press: the row is already resolved', async () => {
    const id = await idOf('pay_ghost');
    await resolve(adminUser, id);

    const again = await resolve(adminUser, id);
    expect(again).toEqual([]);
  });

  it('never deletes the row: a money problem keeps its trail', async () => {
    const id = await idOf('pay_ghost');
    await resolve(adminUser, id);

    const all = await db.admin.query<{ resolved_at: string | null }>(
      'select resolved_at from public.reconcile_alerts',
    );
    expect(all.rows).toHaveLength(2);
    expect(all.rows.filter((r) => r.resolved_at !== null)).toHaveLength(1);
  });
});

describe('a teacher', () => {
  beforeEach(async () => {
    await alert('no_purchase', 'pay_ghost');
  });

  it('cannot read one: the payload names another teacher sale', async () => {
    expect(await listOpen(teacher)).toEqual([]);
  });

  it('cannot resolve one', async () => {
    const id = await idOf('pay_ghost');

    // RLS hands them zero rows, so the UPDATE matches nothing. The row is
    // untouched either way, which is what the next assertion proves.
    expect(await resolve(teacher, id)).toEqual([]);

    const still = await db.admin.query<{ resolved_at: string | null }>(
      'select resolved_at from public.reconcile_alerts where id = $1',
      [id],
    );
    expect(still.rows[0].resolved_at).toBeNull();
  });
});

describe('a student', () => {
  beforeEach(async () => {
    await alert('no_purchase', 'pay_ghost');
  });

  it('cannot read one', async () => {
    expect(await listOpen(student)).toEqual([]);
  });

  it('cannot resolve one', async () => {
    const id = await idOf('pay_ghost');
    expect(await resolve(student, id)).toEqual([]);

    const still = await db.admin.query<{ resolved_at: string | null }>(
      'select resolved_at from public.reconcile_alerts where id = $1',
      [id],
    );
    expect(still.rows[0].resolved_at).toBeNull();
  });
});

describe('nobody signed in', () => {
  beforeEach(async () => {
    await alert('no_purchase', 'pay_ghost');
  });

  it('reads nothing: there is no anon policy at all', async () => {
    const rows = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.reconcile_alerts');
      return res.rows;
    });
    expect(rows).toEqual([]);
  });
});
