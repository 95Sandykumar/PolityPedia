/**
 * Buying a mock set: the order row and the Rs 0 coupon path
 * (issue 26-razorpay-order-checkout).
 *
 * design.md flow 4: "Razorpay Order (amount from DB, never from the browser)
 * -> checkout -> webhook -> `purchases` row `paid` -> `set_access` row". The
 * webhook half is issue 27. This file is the first half, and the three design
 * constraints it has to keep:
 *
 *  * F-G2 -- the amount comes from `mock_sets.price_inr`. There is no amount
 *            PARAMETER on `start_set_purchase()`, so a patched browser has
 *            nothing to lie about.
 *  * A4   -- a 100% coupon lands on `set_access` with no Razorpay call, and
 *            both rows are written in ONE transaction.
 *  * A1   -- `purchases.razorpay_order_id` is UNIQUE, so one Razorpay order
 *            can never be two purchases.
 *
 * Plus the two a money table lives or dies by:
 *
 *  * a student reads their OWN purchases and nobody else's,
 *  * a student cannot write a `purchases` row by hand (that is a free set,
 *    one INSERT at a time), and cannot read the `coupons` table (that is a
 *    100%-off code anybody can look up).
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the set under test. */
let teacher: string;
/** The buyer. */
let student: string;
/** A second student, so "my purchases" can be told apart from "a purchase". */
let other: string;
/** The only user who may write a coupon. */
let adminUser: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

let setId: string;

async function insertSet(values: { price?: number; status?: string; title?: string } = {}) {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      teacher,
      NET,
      values.title ?? 'Full length set 1',
      values.price ?? 399,
      values.status ?? 'live',
    ],
  );
  return res.rows[0].id;
}

interface Started {
  purchase_id: string;
  amount_inr: number;
  status: string;
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

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();
  other = await db.createUser();
  adminUser = await db.createUser();

  // `profiles_block_role_change` refuses a role change by anybody but an
  // admin, so the first admin is seeded as a fresh row, not an update.
  await db.admin.query('delete from public.profiles where id = $1', [adminUser]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [adminUser]);

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
  await db.admin.query('delete from public.purchases');
  await db.admin.query('delete from public.coupons');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.mock_sets');
  setId = await insertSet({ price: 399 });
});

describe('the migration', () => {
  it('is applied in issue-number order', () => {
    expect(db.migrations).toContain('0026_purchases.sql');
  });
});

describe('F-G2: the amount comes from our database', () => {
  it('charges the set price, and takes no amount from the caller', async () => {
    const started = await startAs(student, setId);

    expect(started.amount_inr).toBe(399);
    expect(started.status).toBe('created');

    // The proof that the price cannot be sent in: the function takes exactly
    // two arguments, a set id and a coupon. There is nowhere to put an amount.
    const args = await db.admin.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'start_set_purchase'`,
    );
    expect(args.rows).toHaveLength(1);
    expect(args.rows[0].args).not.toMatch(/amount/i);
  });

  it('follows the price when the teacher sells cheaper', async () => {
    const cheap = await insertSet({ price: 299, title: 'Full length set 2' });
    const started = await startAs(student, cheap);
    expect(started.amount_inr).toBe(299);
  });

  it('stores the amount it quoted, so a later webhook can compare', async () => {
    const started = await startAs(student, setId);
    const row = await db.admin.query<{ amount_inr: number; razorpay_order_id: string | null }>(
      'select amount_inr, razorpay_order_id from public.purchases where id = $1',
      [started.purchase_id],
    );
    expect(row.rows[0].amount_inr).toBe(399);
    // No order id yet: Razorpay has not been called at this point.
    expect(row.rows[0].razorpay_order_id).toBeNull();
  });

  it('refuses a draft set, so an unpublished price can never be charged', async () => {
    const draft = await insertSet({ status: 'draft', title: 'Draft set' });
    await expect(startAs(student, draft)).rejects.toThrow();
  });

  it('refuses the teacher buying their own set', async () => {
    await expect(startAs(teacher, setId)).rejects.toThrow();
  });

  it('refuses a set the student already owns', async () => {
    await db.admin.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'purchase', 'infinity')`,
      [student, setId],
    );
    await expect(startAs(student, setId)).rejects.toThrow();
  });
});

describe('A4: a 100% coupon reaches access with no Razorpay', () => {
  beforeEach(async () => {
    await db.asUser(adminUser, async (sql) => {
      await sql.query(
        `insert into public.coupons (code, percent_off, max_uses) values
           ('FREE100', 100, 5), ('HALF50', 50, 5), ('USEDUP', 100, 1)`,
      );
    });
    await db.admin.query("update public.coupons set used = 1 where code = 'USEDUP'");
  });

  it('writes a paid purchase and a purchase set_access row in one go', async () => {
    const started = await startAs(student, setId, 'FREE100');

    expect(started.amount_inr).toBe(0);
    expect(started.status).toBe('paid');

    const purchase = await db.admin.query<{
      status: string;
      coupon: string;
      amount_inr: number;
    }>('select status, coupon, amount_inr from public.purchases where id = $1', [
      started.purchase_id,
    ]);
    expect(purchase.rows[0]).toMatchObject({
      status: 'paid',
      coupon: 'FREE100',
      amount_inr: 0,
    });

    const access = await db.admin.query<{ source: string; valid_until: string }>(
      'select source, valid_until::text from public.set_access where user_id = $1 and set_id = $2',
      [student, setId],
    );
    expect(access.rows).toHaveLength(1);
    expect(access.rows[0].source).toBe('purchase');
    expect(access.rows[0].valid_until).toBe('infinity');
  });

  it('opens the set for real: the paid test stops being locked', async () => {
    await startAs(student, setId, 'FREE100');

    const test = await db.admin.query<{ id: string }>(
      `insert into public.mock_tests (set_id, title, position) values ($1, 'Test 2', 2)
       returning id`,
      [setId],
    );
    const open = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ ok: boolean }>('select public.has_test_access($1) as ok', [
        test.rows[0].id,
      ]);
      return res.rows[0].ok;
    });
    expect(open).toBe(true);
  });

  it('spends one use of the coupon', async () => {
    await startAs(student, setId, 'FREE100');
    const row = await db.admin.query<{ used: number }>(
      "select used from public.coupons where code = 'FREE100'",
    );
    expect(row.rows[0].used).toBe(1);
  });

  it('still asks for money on a part coupon, and grants nothing yet', async () => {
    const started = await startAs(student, setId, 'HALF50');

    // ceil(399 * 50 / 100). Rounded UP, so the rupee is never lost to us.
    expect(started.amount_inr).toBe(200);
    expect(started.status).toBe('created');

    const access = await db.admin.query(
      'select 1 from public.set_access where user_id = $1 and set_id = $2',
      [student, setId],
    );
    expect(access.rows).toHaveLength(0);

    // An unpaid order does not spend the coupon: the webhook (issue 27) does.
    const row = await db.admin.query<{ used: number }>(
      "select used from public.coupons where code = 'HALF50'",
    );
    expect(row.rows[0].used).toBe(0);
  });

  it('reads a coupon code case-insensitively and stores it upper case', async () => {
    const started = await startAs(student, setId, ' free100 ');
    expect(started.amount_inr).toBe(0);
    const row = await db.admin.query<{ coupon: string }>(
      'select coupon from public.purchases where id = $1',
      [started.purchase_id],
    );
    expect(row.rows[0].coupon).toBe('FREE100');
  });

  it('refuses an unknown coupon instead of charging full price quietly', async () => {
    await expect(startAs(student, setId, 'NOPE')).rejects.toThrow();
  });

  it('refuses a coupon that has run out of uses', async () => {
    await expect(startAs(student, setId, 'USEDUP')).rejects.toThrow();
  });

  it('never lets the same code be spent past max_uses', async () => {
    const one = await insertSet({ title: 'Set A' });
    const two = await insertSet({ title: 'Set B' });
    await db.asUser(adminUser, async (sql) => {
      await sql.query(
        "insert into public.coupons (code, percent_off, max_uses) values ('ONLYONE', 100, 1)",
      );
    });

    await startAs(student, one, 'ONLYONE');
    await expect(startAs(other, two, 'ONLYONE')).rejects.toThrow();
  });

  it('writes nothing at all when the coupon is refused', async () => {
    await expect(startAs(student, setId, 'USEDUP')).rejects.toThrow();
    const purchases = await db.admin.query('select 1 from public.purchases');
    expect(purchases.rows).toHaveLength(0);
  });
});

describe('A1: one Razorpay order is one purchase', () => {
  it('refuses a second purchase with the same order id', async () => {
    const a = await startAs(student, setId);
    const second = await insertSet({ title: 'Full length set 3' });
    const b = await startAs(other, second);

    await attachAs(student, a.purchase_id, 'order_SAME');
    await expect(attachAs(other, b.purchase_id, 'order_SAME')).rejects.toThrow();
  });

  it('attaches the order id once and never repoints it', async () => {
    const a = await startAs(student, setId);

    await attachAs(student, a.purchase_id, 'order_FIRST');
    await expect(attachAs(student, a.purchase_id, 'order_SECOND')).rejects.toThrow();

    const row = await db.admin.query<{ razorpay_order_id: string }>(
      'select razorpay_order_id from public.purchases where id = $1',
      [a.purchase_id],
    );
    expect(row.rows[0].razorpay_order_id).toBe('order_FIRST');
  });

  it('refuses to attach an order id to another student purchase', async () => {
    const a = await startAs(student, setId);
    await expect(attachAs(other, a.purchase_id, 'order_THEFT')).rejects.toThrow();
  });

  it('keeps many un-attached purchases side by side', async () => {
    // UNIQUE on a nullable column allows many NULLs, so an abandoned checkout
    // never blocks the next one.
    const second = await insertSet({ title: 'Full length set 5' });
    await startAs(student, setId);
    await startAs(student, second);

    const rows = await db.admin.query('select 1 from public.purchases');
    expect(rows.rows).toHaveLength(2);
  });
});

describe('RLS: a purchase is private', () => {
  it('shows a student their own purchases and no others', async () => {
    const mine = await startAs(student, setId);
    const second = await insertSet({ title: 'Full length set 4' });
    await startAs(other, second);

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>('select id from public.purchases');
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mine.purchase_id);
  });

  it('shows a visitor who is not signed in nothing', async () => {
    await startAs(student, setId);
    const rows = await db.asAnon(async (sql) => {
      const res = await sql.query('select id from public.purchases');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('refuses a purchase a student writes by hand', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.purchases (user_id, set_id, amount_inr, status)
           values ($1, $2, 0, 'paid')`,
          [student, setId],
        );
      }),
    ).rejects.toThrow();
  });

  it('refuses a status a student flips by hand', async () => {
    const mine = await startAs(student, setId);
    await db.asUser(student, async (sql) => {
      await sql.query("update public.purchases set status = 'paid' where id = $1", [
        mine.purchase_id,
      ]);
    });
    const row = await db.admin.query<{ status: string }>(
      'select status from public.purchases where id = $1',
      [mine.purchase_id],
    );
    expect(row.rows[0].status).toBe('created');
  });

  it('hides the coupons table from a student', async () => {
    await db.asUser(adminUser, async (sql) => {
      await sql.query(
        "insert into public.coupons (code, percent_off, max_uses) values ('SECRET100', 100, 9)",
      );
    });

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query('select code from public.coupons');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('refuses a coupon a student writes themselves', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          "insert into public.coupons (code, percent_off, max_uses) values ('MINE100', 100, 9)",
        );
      }),
    ).rejects.toThrow();
  });
});
