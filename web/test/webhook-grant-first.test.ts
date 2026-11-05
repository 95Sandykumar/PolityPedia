/**
 * A crash must not leave a paying student locked out
 * (issue 34-webhook-grant-first).
 *
 * The 2026-11-05 review found one gap and three missing guards in the money
 * path built by issues 27, 28 and 29.
 *
 * THE GAP. `handleRazorpayWebhook()` used to call `record_payment_event()`
 * first and the action second, in TWO round trips. Kill the server between
 * them and the event id is stored while the set stays shut: Razorpay's retry
 * is then a "duplicate" that does nothing, and a student who paid sees a
 * locked set forever. `forget_payment_event()` only ran if the process was
 * still alive to run it, which is exactly what a timeout takes away.
 *
 * THE FIX, in two halves:
 *
 *  1. The three IDEMPOTENT actions (`grant_purchase`, `refund_purchase`,
 *     `mark_subscription`) run FIRST, with no de-dupe gate in front of them,
 *     and the event id is written afterwards for audit. A crash in between is
 *     harmless: the retry runs the same idempotent action again.
 *  2. `charge_subscription()` was NOT idempotent: it added a month per call.
 *     It now takes the de-dupe key and does the insert AND the month in ONE
 *     transaction, so there is no "in between" at all. The key comes from the
 *     SIGNED body (`charged:<payment id>`), never from the unsigned
 *     `x-razorpay-event-id` header, so replaying a genuine signed body under a
 *     new header value cannot buy a second month.
 *
 * THE THREE GUARDS:
 *
 *  * an early refund (refund before capture) moves `created -> refunded`, and
 *    the late capture then finds a row that is not `created` and refuses,
 *  * `grant_purchase()` checks the paid amount and the currency against our
 *    own `purchases` row,
 *  * `charge_subscription()` checks the plan the charge was for.
 *
 * Each refusal files a `reconcile_alerts` row and answers FALSE, so the route
 * still replies 200 and Razorpay stops retrying something that can never work.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher, owns the set under test. */
let teacher: string;
/** The buyer and the subscriber. */
let student: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

/** 2% of Rs 399, the test-mode gateway fee this suite uses. */
const FEE = '7.98';

/** Rs 399 in paise, which is what a correct `payment.captured` body says. */
const RIGHT_PAISE = 39_900;

const RZP_SUB = 'sub_test_000000000001';

let setId: string;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function insertSet(price = 399) {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', $3, 'live')
     returning id`,
    [teacher, NET, price],
  );
  return res.rows[0].id;
}

/** Buy and attach an order id: exactly what issue 26's route leaves behind. */
async function checkout(orderId: string) {
  const started = await db.asUser(student, async (sql) => {
    const res = await sql.query<{ purchase_id: string; status: string }>(
      'select * from public.start_set_purchase($1, $2)',
      [setId, null],
    );
    return res.rows[0];
  });
  await db.asUser(student, (sql) =>
    sql.query('select public.attach_order_id($1, $2)', [started.purchase_id, orderId]),
  );
  return started;
}

/** The webhook's own call, as the service role (the owner, in PGlite). */
async function grant(
  orderId: string,
  options: { paise?: number | null; currency?: string | null; fee?: string } = {},
) {
  const res = await db.admin.query<{ granted: boolean }>(
    'select public.grant_purchase($1, $2, $3, $4) as granted',
    [
      orderId,
      options.fee ?? FEE,
      options.paise === undefined ? RIGHT_PAISE : options.paise,
      options.currency === undefined ? 'INR' : options.currency,
    ],
  );
  return res.rows[0].granted;
}

async function refund(orderId: string) {
  const res = await db.admin.query<{ refunded: boolean }>(
    'select public.refund_purchase($1) as refunded',
    [orderId],
  );
  return res.rows[0].refunded;
}

/** `subscription.charged`, the way the webhook now delivers it: ONE call. */
async function charge(
  options: { key?: string | null; plan?: string | null; rzpId?: string } = {},
) {
  const res = await db.admin.query<{ charged: boolean }>(
    `select public.charge_subscription($1, $2, 'subscription.charged', '{}'::jsonb, $3) as charged`,
    [
      options.rzpId ?? RZP_SUB,
      options.key === undefined ? 'charged:pay_test_1' : options.key,
      options.plan === undefined ? null : options.plan,
    ],
  );
  return res.rows[0].charged;
}

/** A subscription that the UI has opened and attached. */
async function liveSubscription(plan = 'ai', rzpId = RZP_SUB) {
  const started = await db.asUser(student, async (sql) => {
    const res = await sql.query<{ subscription_id: string }>(
      'select * from public.start_plan_subscription($1)',
      [plan],
    );
    return res.rows[0];
  });
  await db.asUser(student, (sql) =>
    sql.query('select public.attach_subscription_id($1, $2)', [started.subscription_id, rzpId]),
  );
  return started;
}

function purchaseStatus(orderId: string) {
  return db.admin
    .query<{ status: string }>('select status from public.purchases where razorpay_order_id = $1', [
      orderId,
    ])
    .then((r) => r.rows[0]?.status ?? null);
}

function count(table: string) {
  return db.admin
    .query<{ n: number }>(`select count(*)::int as n from ${table}`)
    .then((r) => r.rows[0].n);
}

/** Days from now until the plan runs out. One month is about 30 or 31. */
async function planDays(plan = 'ai') {
  const res = await db.admin.query<{ days: number | null }>(
    `select round(extract(epoch from (valid_until - now())) / 86400)::int as days
     from public.entitlements where user_id = $1 and plan = $2`,
    [student, plan],
  );
  return res.rows[0]?.days ?? null;
}

function alerts() {
  return db.admin
    .query<{
      kind: string;
      subject: string;
      order_id: string | null;
      expected_paise: string | null;
      actual_paise: string | null;
    }>(
      `select kind, subject, order_id, expected_paise::text, actual_paise::text
       from public.reconcile_alerts order by kind`,
    )
    .then((r) => r.rows);
}

function storedEvents() {
  return db.admin
    .query<{ event_id: string; type: string }>(
      'select event_id, type from public.payment_events order by event_id',
    )
    .then((r) => r.rows);
}

// --------------------------------------------------------------------------

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();

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
  await db.admin.query('delete from public.payment_events');
  await db.admin.query('delete from public.reconcile_alerts');
  await db.admin.query('delete from public.purchases');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.entitlements');
  await db.admin.query('delete from public.subscriptions');
  await db.admin.query('delete from public.mock_sets');
  setId = await insertSet(399);
});

describe('the migration', () => {
  it('is applied in issue-number order', () => {
    expect(db.migrations).toContain('0034_webhook_grant_first.sql');
  });
});

// --------------------------------------------------------------------------
// 1. The grant is idempotent, so it is safe to run FIRST
// --------------------------------------------------------------------------

describe('grant_purchase runs first and is safe to re-run', () => {
  it('opens the set with no event row written at all', async () => {
    // THE WHOLE POINT. No `record_payment_event()` call before this one, and
    // the sale still completes. That is what makes a crash between the two
    // harmless.
    await checkout('order_first');

    expect(await grant('order_first')).toBe(true);
    expect(await storedEvents()).toEqual([]);
    expect(await purchaseStatus('order_first')).toBe('paid');
    expect(await count('public.teacher_ledger')).toBe(1);
  });

  it('answers false the second time, and writes no second ledger row', async () => {
    await checkout('order_twice');

    expect(await grant('order_twice')).toBe(true);
    expect(await grant('order_twice')).toBe(false);
    expect(await count('public.teacher_ledger')).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 2. subscription.charged: one SQL call, keyed on the SIGNED body
// --------------------------------------------------------------------------

describe('charge_subscription de-dupes inside its own transaction', () => {
  beforeEach(async () => {
    await liveSubscription('ai');
  });

  it('adds one month, and stores the key as the event row', async () => {
    expect(await charge({ key: 'charged:pay_m1' })).toBe(true);

    expect(await planDays()).toBeGreaterThanOrEqual(28);
    expect(await planDays()).toBeLessThanOrEqual(32);
    expect(await storedEvents()).toEqual([
      { event_id: 'charged:pay_m1', type: 'subscription.charged' },
    ]);
  });

  it('adds ONE month for the same payment id delivered twice', async () => {
    expect(await charge({ key: 'charged:pay_m1' })).toBe(true);
    const after = await planDays();

    // The retry. Same signed body, same payment id, same key.
    expect(await charge({ key: 'charged:pay_m1' })).toBe(false);
    expect(await planDays()).toBe(after);
    expect(await storedEvents()).toHaveLength(1);
  });

  it('adds nothing when the body is replayed under a new header event id', async () => {
    // The header is UNSIGNED. Anybody who can replay a genuine signed body can
    // put any value they like in `x-razorpay-event-id`, so the header must not
    // be what buys a month.
    expect(await charge({ key: 'charged:pay_m1' })).toBe(true);
    const after = await planDays();

    // A new header id stored the way the old code would have stored it.
    await db.admin.query(
      `select public.record_payment_event('evt_attacker_2', 'subscription.charged', '{}'::jsonb)`,
    );

    // The charge still refuses: its key comes from the body, not the header.
    expect(await charge({ key: 'charged:pay_m1' })).toBe(false);
    expect(await planDays()).toBe(after);
  });

  it('stacks a real second month, because the payment id is new', async () => {
    expect(await charge({ key: 'charged:pay_m1' })).toBe(true);
    expect(await charge({ key: 'charged:pay_m2' })).toBe(true);

    const days = await planDays();
    expect(days).toBeGreaterThanOrEqual(58);
    expect(await storedEvents()).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------
// 3. A refund that arrives before its capture
// --------------------------------------------------------------------------

describe('a refund that lands before the capture', () => {
  it('moves created -> refunded, and the late capture cannot reopen it', async () => {
    await checkout('order_early');
    expect(await purchaseStatus('order_early')).toBe('created');

    // A refund implies a capture, so a `created` row with an order attached
    // is refundable.
    expect(await refund('order_early')).toBe(true);
    expect(await purchaseStatus('order_early')).toBe('refunded');

    // The capture, a second late. `grant_purchase()` only moves `created`.
    expect(await grant('order_early')).toBe(false);
    expect(await purchaseStatus('order_early')).toBe('refunded');

    // No money owed to a teacher, and no open set.
    expect(await count('public.teacher_ledger')).toBe(0);
    expect(await count('public.set_access')).toBe(0);
  });

  it('refuses a second refund, and refuses an order that is not ours', async () => {
    await checkout('order_once');
    expect(await refund('order_once')).toBe(true);
    expect(await refund('order_once')).toBe(false);
    expect(await refund('order_not_ours')).toBe(false);
  });

  it('still shuts a set that was already paid for', async () => {
    await checkout('order_normal');
    expect(await grant('order_normal')).toBe(true);
    expect(await count('public.set_access')).toBe(1);

    expect(await refund('order_normal')).toBe(true);
    expect(await purchaseStatus('order_normal')).toBe('refunded');
    expect(await count('public.set_access')).toBe(0);
    // A ledger is append-only (0027): the row stays, the payout report drops it.
    expect(await count('public.teacher_ledger')).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 4. The amount and the currency, from the signed body
// --------------------------------------------------------------------------

describe('grant_purchase checks what was actually paid', () => {
  it('grants when the paise and the currency agree with our row', async () => {
    await checkout('order_right');
    expect(await grant('order_right', { paise: RIGHT_PAISE, currency: 'inr' })).toBe(true);
    expect(await alerts()).toEqual([]);
  });

  it('refuses a short payment, files one alert and opens nothing', async () => {
    await checkout('order_short');

    expect(await grant('order_short', { paise: 100 })).toBe(false);
    expect(await purchaseStatus('order_short')).toBe('created');
    expect(await count('public.set_access')).toBe(0);
    expect(await count('public.teacher_ledger')).toBe(0);

    expect(await alerts()).toEqual([
      {
        kind: 'amount_mismatch',
        subject: 'order:order_short',
        order_id: 'order_short',
        expected_paise: '39900',
        actual_paise: '100',
      },
    ]);
  });

  it('files ONE alert however many times the same body is retried', async () => {
    await checkout('order_retry');
    await grant('order_retry', { paise: 100 });
    await grant('order_retry', { paise: 100 });
    expect(await alerts()).toHaveLength(1);
  });

  it('refuses a currency that is not INR', async () => {
    await checkout('order_usd');

    expect(await grant('order_usd', { currency: 'USD' })).toBe(false);
    expect(await purchaseStatus('order_usd')).toBe('created');
    expect(await count('public.teacher_ledger')).toBe(0);

    const filed = await alerts();
    expect(filed).toHaveLength(1);
    expect(filed[0].kind).toBe('currency_mismatch');
    expect(filed[0].subject).toBe('order:order_usd');
  });

  it('still grants when the gateway told us no amount at all', async () => {
    // An `order.paid` body with no payment entity has nothing to check. A
    // missing number must not shut a sale that really happened; the nightly
    // reconcile (A6) is what catches it.
    await checkout('order_quiet');
    expect(await grant('order_quiet', { paise: null, currency: null })).toBe(true);
    expect(await alerts()).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 5. The plan the charge was for
// --------------------------------------------------------------------------

describe('charge_subscription checks the plan', () => {
  it('buys the month when the plan matches the row', async () => {
    await liveSubscription('ai');
    expect(await charge({ plan: 'ai' })).toBe(true);
    expect(await alerts()).toEqual([]);
    expect(await planDays()).toBeGreaterThanOrEqual(28);
  });

  it('refuses a charge for a different plan, and files an alert', async () => {
    await liveSubscription('ai');

    expect(await charge({ key: 'charged:pay_wrong', plan: 'pro' })).toBe(false);
    expect(await planDays('ai')).toBeNull();
    expect(await planDays('pro')).toBeNull();

    const filed = await alerts();
    expect(filed).toHaveLength(1);
    expect(filed[0].kind).toBe('plan_mismatch');
    expect(filed[0].subject).toBe('charged:pay_wrong');
  });

  it('refuses a plan id we could not place at all', async () => {
    await liveSubscription('ai');
    expect(await charge({ plan: 'unknown' })).toBe(false);
    expect(await planDays('ai')).toBeNull();
    expect((await alerts())[0].kind).toBe('plan_mismatch');
  });

  it('buys the month when the gateway told us no plan', async () => {
    await liveSubscription('ai');
    expect(await charge({ plan: null })).toBe(true);
    expect(await alerts()).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 6. The old grants still hold
// --------------------------------------------------------------------------

describe('a student still cannot call any of them', () => {
  it('refuses all three to an ordinary signed-in account', async () => {
    await checkout('order_cheat');
    await liveSubscription('ai');

    const attempts = [
      `select public.grant_purchase('order_cheat', 0, 39900, 'INR')`,
      `select public.refund_purchase('order_cheat')`,
      `select public.charge_subscription('${RZP_SUB}', 'charged:pay_cheat')`,
    ];
    for (const attempt of attempts) {
      await expect(db.asUser(student, (client) => client.query(attempt))).rejects.toThrow();
    }

    expect(await purchaseStatus('order_cheat')).toBe('created');
    expect(await planDays()).toBeNull();
  });
});
