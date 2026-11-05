/**
 * The webhook's half of a sale: de-dupe, access, and the teacher ledger
 * (issue 27-razorpay-webhook-ledger).
 *
 * design.md flow 4: "... -> webhook (signature first) -> `payment_events`
 * de-dupe -> `purchases` row `paid` -> `set_access` row -> `teacher_ledger`
 * row with the split." Issue 26 built everything up to the checkout. This
 * file is what happens when Razorpay says the money arrived.
 *
 * The signature itself is JavaScript (`src/lib/purchases/webhook.ts`), because
 * the raw request body never reaches Postgres. Everything AFTER the signature
 * is here, in the database, because that is the only place a retried webhook
 * cannot race itself:
 *
 *  * A1 -- `payment_events.event_id` is the primary key and
 *          `teacher_ledger.purchase_id` is UNIQUE, so the same event twice
 *          writes one ledger row.
 *  * A3 -- forward only. created -> paid -> refunded, and never back.
 *  * A5 -- the purchase, the access and the ledger row land in ONE
 *          transaction keyed on the purchase id, so a half-done sale (money
 *          taken, set shut) cannot exist.
 *  * X2 -- a bought set stays open until the teacher's next exam date for
 *          that exam + 30 days, else 12 months.
 *  * X3 -- the teacher's share is on the NET (gross - GST - gateway fee), and
 *          `share_pct` is COPIED at sale time so a later change of share does
 *          not rewrite history.
 *
 * Plus the one a money table lives or dies by: a student cannot call
 * `grant_purchase()` themselves. If they could, every mock set is free.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the set under test, and earns the share. */
let teacher: string;
/** The buyer. */
let student: string;
/** The only user who may read the ledger by hand. */
let adminUser: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

/** 2% of Rs 399, the test-mode gateway fee this suite uses. */
const FEE = '7.98';

let setId: string;

async function insertSet(values: { price?: number; title?: string } = {}) {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, $4, 'live')
     returning id`,
    [teacher, NET, values.title ?? 'Full length set 1', values.price ?? 399],
  );
  return res.rows[0].id;
}

interface Started {
  purchase_id: string;
  amount_inr: number;
  status: string;
}

/** Buy and attach an order id: exactly what issue 26's route leaves behind. */
async function checkout(forSet: string, orderId: string, coupon: string | null = null) {
  const started = await db.asUser(student, async (sql) => {
    const res = await sql.query<Started>('select * from public.start_set_purchase($1, $2)', [
      forSet,
      coupon,
    ]);
    return res.rows[0];
  });
  if (started.status === 'created') {
    await db.asUser(student, async (sql) => {
      await sql.query('select public.attach_order_id($1, $2)', [started.purchase_id, orderId]);
    });
  }
  return started;
}

/** The webhook's own calls run as the SERVICE ROLE, i.e. the database owner. */
function grant(orderId: string, fee: string = FEE) {
  return db.admin
    .query<{ granted: boolean }>('select public.grant_purchase($1, $2) as granted', [orderId, fee])
    .then((r) => r.rows[0].granted);
}

function refund(orderId: string) {
  return db.admin
    .query<{ refunded: boolean }>('select public.refund_purchase($1) as refunded', [orderId])
    .then((r) => r.rows[0].refunded);
}

function recordEvent(eventId: string, type = 'payment.captured') {
  return db.admin
    .query<{ fresh: boolean }>('select public.record_payment_event($1, $2, $3::jsonb) as fresh', [
      eventId,
      type,
      '{"hello":"world"}',
    ])
    .then((r) => r.rows[0].fresh);
}

interface LedgerRow {
  teacher_id: string;
  purchase_id: string;
  gross: string;
  gst: string;
  gateway_fee: string;
  net: string;
  share_pct: number;
  teacher_amount: string;
  platform_amount: string;
  payout_id: string | null;
}

function ledgerRows() {
  return db.admin
    .query<LedgerRow>('select * from public.teacher_ledger order by created_at')
    .then((r) => r.rows);
}

function accessRows() {
  return db.admin
    .query<{ source: string; valid_until: string; set_id: string }>(
      'select source, set_id, valid_until from public.set_access order by source',
    )
    .then((r) => r.rows);
}

function purchaseStatus(orderId: string) {
  return db.admin
    .query<{ status: string }>('select status from public.purchases where razorpay_order_id = $1', [
      orderId,
    ])
    .then((r) => r.rows[0]?.status ?? null);
}

/** Days from now until a purchase-sourced access row runs out. */
async function accessDays() {
  const res = await db.admin.query<{ days: string }>(
    `select round(extract(epoch from (a.valid_until - now())) / 86400)::text as days
     from public.set_access a where a.source = 'purchase'`,
  );
  return Number(res.rows[0].days);
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();
  adminUser = await db.createUser();

  // `profiles_block_role_change` refuses a role change by anybody but an
  // admin, so the first admin is seeded as a fresh row, not an update.
  await db.admin.query('delete from public.profiles where id = $1', [adminUser]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [adminUser]);

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status, revenue_share_pct)
     values ($1, 'alias', 'Polity Guru', 'approved', 50)`,
    [teacher],
  );
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.teacher_ledger');
  await db.admin.query('delete from public.payouts');
  await db.admin.query('delete from public.payment_events');
  await db.admin.query('delete from public.purchases');
  await db.admin.query('delete from public.coupons');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.teacher_exams');
  await db.admin.query('delete from public.mock_sets');
  await db.admin.query('update public.teachers set revenue_share_pct = 50 where user_id = $1', [
    teacher,
  ]);
  setId = await insertSet({ price: 399 });
});

describe('the migration', () => {
  it('is applied in issue-number order', () => {
    expect(db.migrations).toContain('0027_ledger.sql');
  });

  it('puts RLS on all three money tables', async () => {
    const res = await db.admin.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('payment_events', 'teacher_ledger', 'payouts')
       order by c.relname`,
    );
    expect(res.rows.map((r) => r.relname)).toEqual([
      'payment_events',
      'payouts',
      'teacher_ledger',
    ]);
    for (const row of res.rows) expect(row.relrowsecurity).toBe(true);
  });
});

describe('A2: the event is de-duped on its own id', () => {
  it('stores a fresh event once and refuses the repeat', async () => {
    expect(await recordEvent('evt_one')).toBe(true);
    expect(await recordEvent('evt_one')).toBe(false);

    const res = await db.admin.query<{ n: number | string }>(
      'select count(*) as n from public.payment_events',
    );
    expect(Number(res.rows[0].n)).toBe(1);
  });

  it('releases the id again when the handling failed, so a retry works', async () => {
    expect(await recordEvent('evt_undo')).toBe(true);

    const forgot = await db.admin.query<{ gone: boolean }>(
      'select public.forget_payment_event($1) as gone',
      ['evt_undo'],
    );
    expect(forgot.rows[0].gone).toBe(true);

    // The retry is now a fresh event, not a de-duped no-op.
    expect(await recordEvent('evt_undo')).toBe(true);

    // Forgetting an id we never stored is a harmless false.
    const missing = await db.admin.query<{ gone: boolean }>(
      'select public.forget_payment_event($1) as gone',
      ['evt_never'],
    );
    expect(missing.rows[0].gone).toBe(false);
  });

  it('keeps the type and the payload it was handed', async () => {
    await recordEvent('evt_typed', 'payment.failed');
    const res = await db.admin.query<{ type: string; payload: unknown }>(
      'select type, payload from public.payment_events where event_id = $1',
      ['evt_typed'],
    );
    expect(res.rows[0].type).toBe('payment.failed');
    expect(res.rows[0].payload).toEqual({ hello: 'world' });
  });
});

describe('A5: one captured payment opens the set and writes one ledger row', () => {
  it('moves the purchase to paid, opens the set and splits the money', async () => {
    const started = await checkout(setId, 'order_live_1');
    expect(started.status).toBe('created');

    expect(await grant('order_live_1')).toBe(true);
    expect(await purchaseStatus('order_live_1')).toBe('paid');

    const access = await accessRows();
    expect(access).toHaveLength(1);
    expect(access[0].source).toBe('purchase');
    expect(access[0].set_id).toBe(setId);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].teacher_id).toBe(teacher);
    expect(rows[0].purchase_id).toBe(started.purchase_id);
    expect(rows[0].payout_id).toBeNull();
  });

  it('is right to the paisa for Rs 399 at 50% with a test fee', async () => {
    await checkout(setId, 'order_live_2');
    await grant('order_live_2');

    const [row] = await ledgerRows();

    // gross 399.00
    // gst   = 399 - 399 / 1.18 = 60.8644... -> 60.86
    // net   = 399.00 - 60.86 - 7.98         = 330.16
    // 50%   = 165.08 each, and the two halves add back up to the net.
    expect(row.gross).toBe('399.00');
    expect(row.gst).toBe('60.86');
    expect(row.gateway_fee).toBe('7.98');
    expect(row.net).toBe('330.16');
    expect(row.share_pct).toBe(50);
    expect(row.teacher_amount).toBe('165.08');
    expect(row.platform_amount).toBe('165.08');
  });

  it('never loses a paisa, whatever the share and the fee', async () => {
    await db.admin.query('update public.teachers set revenue_share_pct = 33 where user_id = $1', [
      teacher,
    ]);
    await checkout(setId, 'order_live_3');
    await grant('order_live_3', '7.33');

    const res = await db.admin.query<{ whole: string; split: string; net: string }>(
      `select (gst + gateway_fee + net)::text         as whole,
              (teacher_amount + platform_amount)::text as split,
              net::text                                as net
       from public.teacher_ledger`,
    );
    // Nothing evaporates: the three parts rebuild the gross, and the two
    // shares rebuild the net, EXACTLY, with no rounding dust left over.
    expect(res.rows[0].whole).toBe('399.00');
    expect(res.rows[0].split).toBe(res.rows[0].net);

    const [row] = await ledgerRows();
    expect(row.share_pct).toBe(33);
  });
});

describe('A1: the same webhook twice changes nothing', () => {
  it('writes ONE ledger row for two grants of one order', async () => {
    await checkout(setId, 'order_twice');

    expect(await grant('order_twice')).toBe(true);
    expect(await grant('order_twice')).toBe(false);

    expect(await ledgerRows()).toHaveLength(1);
    expect(await accessRows()).toHaveLength(1);
    expect(await purchaseStatus('order_twice')).toBe('paid');
  });

  it('answers false for an order we never sold', async () => {
    expect(await grant('order_not_ours')).toBe(false);
    expect(await ledgerRows()).toHaveLength(0);
  });
});

describe('X2: how long the set stays open', () => {
  it('uses the teacher next exam date for that exam, plus 30 days', async () => {
    await db.admin.query(
      `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
       values ($1, $2, (now() + interval '60 days')::date)`,
      [teacher, NET],
    );

    await checkout(setId, 'order_dated');
    await grant('order_dated');

    // 60 days to the exam, plus the 30 day tail.
    const days = await accessDays();
    expect(days).toBeGreaterThanOrEqual(89);
    expect(days).toBeLessThanOrEqual(91);
  });

  it('falls back to 12 months when the teacher set no date', async () => {
    await checkout(setId, 'order_undated');
    await grant('order_undated');

    const days = await accessDays();
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  });

  it('falls back to 12 months when the date has already gone past', async () => {
    await db.admin.query(
      `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
       values ($1, $2, (now() - interval '200 days')::date)`,
      [teacher, NET],
    );

    await checkout(setId, 'order_stale');
    await grant('order_stale');

    // A stale date must not sell a set that is shut on arrival.
    const days = await accessDays();
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  });

  it('opens the questions for real, through the paywall', async () => {
    const test = await db.admin.query<{ id: string }>(
      `insert into public.mock_tests (set_id, title, position)
       values ($1, 'Test 1', 1) returning id`,
      [setId],
    );
    const testId = test.rows[0].id;

    const shut = await db.asUser(student, async (sql) => {
      const r = await sql.query<{ open: boolean }>('select public.has_test_access($1) as open', [
        testId,
      ]);
      return r.rows[0].open;
    });
    expect(shut).toBe(false);

    await checkout(setId, 'order_opens');
    await grant('order_opens');

    const open = await db.asUser(student, async (sql) => {
      const r = await sql.query<{ open: boolean }>('select public.has_test_access($1) as open', [
        testId,
      ]);
      return r.rows[0].open;
    });
    expect(open).toBe(true);
  });
});

describe('A3: forward only', () => {
  it('a refund before paid shuts the row, and the late capture cannot reopen it', async () => {
    await checkout(setId, 'order_early_refund');

    // ISSUE 34-WEBHOOK-GRANT-FIRST TURNED THIS ROUND. 0027 refused to refund a
    // `created` row, in case a capture was a second behind. Razorpay does not
    // refund money it never took, so a refund for a `created` row of ours
    // means OUR capture webhook is late or lost, and leaving the row `created`
    // lets that late capture open a set the student has been paid back for.
    expect(await refund('order_early_refund')).toBe(true);
    expect(await purchaseStatus('order_early_refund')).toBe('refunded');

    // The late capture, and `grant_purchase()` only ever moves `created`.
    expect(await grant('order_early_refund')).toBe(false);
    expect(await purchaseStatus('order_early_refund')).toBe('refunded');

    // Still forward only: no money owed to a teacher, and no open set.
    expect(await accessRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('a refund after paid shuts the set', async () => {
    await checkout(setId, 'order_refund');
    await grant('order_refund');
    expect(await accessRows()).toHaveLength(1);

    expect(await refund('order_refund')).toBe(true);
    expect(await purchaseStatus('order_refund')).toBe('refunded');
    expect(await accessRows()).toHaveLength(0);
  });

  it('a late capture cannot reopen a refunded purchase', async () => {
    await checkout(setId, 'order_late');
    await grant('order_late');
    await refund('order_late');

    expect(await grant('order_late')).toBe(false);
    expect(await purchaseStatus('order_late')).toBe('refunded');
    expect(await accessRows()).toHaveLength(0);
  });

  it('leaves a batch grant alone when a purchase is refunded', async () => {
    // Checkout first: `start_set_purchase()` refuses a set that is already
    // unlocked (0026, PP409), so the batch grant has to arrive afterwards,
    // which is the real order anyway (a teacher adds a batch mid-month).
    await checkout(setId, 'order_batch_too');
    await db.admin.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'batch', now() + interval '30 days')`,
      [student, setId],
    );

    await grant('order_batch_too');
    await refund('order_batch_too');

    const access = await accessRows();
    expect(access).toHaveLength(1);
    expect(access[0].source).toBe('batch');
  });
});

describe('X3: the share is copied at sale time', () => {
  it('changing the teacher share later does not change an old ledger row', async () => {
    await checkout(setId, 'order_share');
    await grant('order_share');

    const before = await ledgerRows();
    expect(before[0].share_pct).toBe(50);
    expect(before[0].teacher_amount).toBe('165.08');

    await db.admin.query('update public.teachers set revenue_share_pct = 90 where user_id = $1', [
      teacher,
    ]);

    const after = await ledgerRows();
    expect(after[0].share_pct).toBe(50);
    expect(after[0].teacher_amount).toBe('165.08');
  });

  it('uses the share that was live at the moment of the sale', async () => {
    await db.admin.query('update public.teachers set revenue_share_pct = 70 where user_id = $1', [
      teacher,
    ]);
    await checkout(setId, 'order_seventy');
    await grant('order_seventy');

    const [row] = await ledgerRows();
    expect(row.share_pct).toBe(70);
    // net 330.16, 70% = 231.112 -> 231.11, and the platform keeps the rest.
    expect(row.teacher_amount).toBe('231.11');
    expect(row.platform_amount).toBe('99.05');
  });
});

describe('the coupon use is spent only when the money arrives', () => {
  it('spends one use on the paid webhook, not at checkout', async () => {
    await db.admin.query(
      "insert into public.coupons (code, percent_off, max_uses) values ('HALF50', 50, 5)",
    );

    await checkout(setId, 'order_coupon', 'HALF50');
    const mid = await db.admin.query<{ used: number }>(
      "select used from public.coupons where code = 'HALF50'",
    );
    expect(mid.rows[0].used).toBe(0);

    await grant('order_coupon');
    const after = await db.admin.query<{ used: number }>(
      "select used from public.coupons where code = 'HALF50'",
    );
    expect(after.rows[0].used).toBe(1);

    // Rs 399 at 50% off, rounded up: Rs 200. The ledger follows what was
    // CHARGED, never the list price.
    const [row] = await ledgerRows();
    expect(row.gross).toBe('200.00');
  });
});

describe('a student cannot pay themselves', () => {
  it('refuses every one of the four webhook functions', async () => {
    await checkout(setId, 'order_cheat');

    for (const call of [
      "select public.grant_purchase('order_cheat', 0)",
      "select public.refund_purchase('order_cheat')",
      "select public.record_payment_event('evt_cheat', 'payment.captured', '{}'::jsonb)",
      "select public.forget_payment_event('evt_cheat')",
    ]) {
      await expect(
        db.asUser(student, async (sql) => {
          await sql.query(call);
        }),
      ).rejects.toThrow(/permission denied/i);
    }

    expect(await purchaseStatus('order_cheat')).toBe('created');
    expect(await accessRows()).toHaveLength(0);
  });

  it('refuses a hand-written ledger row, and hides other people money', async () => {
    await checkout(setId, 'order_rls');
    await grant('order_rls');

    const mine = await db.asUser(teacher, async (sql) => {
      const r = await sql.query('select * from public.teacher_ledger');
      return r.rows;
    });
    expect(mine).toHaveLength(1);

    const theirs = await db.asUser(student, async (sql) => {
      const r = await sql.query('select * from public.teacher_ledger');
      return r.rows;
    });
    expect(theirs).toHaveLength(0);

    const events = await db.asUser(teacher, async (sql) => {
      const r = await sql.query('select * from public.payment_events');
      return r.rows;
    });
    expect(events).toHaveLength(0);

    const seen = await db.asUser(adminUser, async (sql) => {
      const r = await sql.query('select * from public.teacher_ledger');
      return r.rows;
    });
    expect(seen).toHaveLength(1);

    await expect(
      db.asUser(teacher, async (sql) => {
        await sql.query(
          `insert into public.teacher_ledger
             (teacher_id, purchase_id, gross, gst, gateway_fee, net, share_pct,
              teacher_amount, platform_amount)
           values ($1, gen_random_uuid(), 399, 60.86, 7.98, 330.16, 100, 330.16, 0)`,
          [teacher],
        );
      }),
    ).rejects.toThrow();
  });

  it('lets a teacher read their own payout rows and nobody else write one', async () => {
    const payout = await db.admin.query<{ id: string }>(
      `insert into public.payouts (teacher_id, period, amount, reference)
       values ($1, '2026-11', 165.08, 'UTR123') returning id`,
      [teacher],
    );

    const mine = await db.asUser(teacher, async (sql) => {
      const r = await sql.query('select * from public.payouts');
      return r.rows;
    });
    expect(mine).toHaveLength(1);

    const theirs = await db.asUser(student, async (sql) => {
      const r = await sql.query('select * from public.payouts');
      return r.rows;
    });
    expect(theirs).toHaveLength(0);

    // No UPDATE policy for a teacher, so the row is simply not there to
    // update: zero rows touched, and the amount stands.
    const touched = await db.asUser(teacher, async (sql) => {
      const r = await sql.query('update public.payouts set amount = 9999 where id = $1', [
        payout.rows[0].id,
      ]);
      return r.affectedRows ?? 0;
    });
    expect(touched).toBe(0);

    const amount = await db.admin.query<{ amount: string }>(
      'select amount from public.payouts where id = $1',
      [payout.rows[0].id],
    );
    expect(amount.rows[0].amount).toBe('165.08');
  });
});
