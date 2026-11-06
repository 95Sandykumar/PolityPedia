/**
 * A dropped subscription charge must leave a line for a human
 * (issue 40-charge-alerts, reviewer finding #10).
 *
 * `charge_subscription()` (0034) writes the de-dupe row into `payment_events`
 * FIRST and the month second, on purpose: one transaction, so a crash cannot
 * leave one without the other.
 *
 * That ordering has a cost nobody paid for until now. Two of its three
 * refusals said FALSE and nothing else:
 *
 *  * the subscription id is not ours (`if not found then return false`), which
 *    is also a real RACE: the `charged` webhook can land before our own
 *    `subscriptions` row is written,
 *  * the subscription is `cancelled` (A3).
 *
 * The de-dupe row is already committed at that point, so Razorpay's retry of
 * the SAME payment id is dropped as "already seen". Money was taken, no month
 * was granted, and the only place that remembered was a FALSE nobody reads.
 * Only the plan mismatch filed a `reconcile_alerts` row.
 *
 * Both now file one, with the same subject style the plan mismatch uses, and
 * both still answer FALSE rather than raising, so the webhook route still
 * replies 2xx and Razorpay stops retrying something that can never work.
 *
 * NOT CHANGED, and asserted here: the de-dupe insert stays first, no month is
 * added by either branch, a repeat is still FALSE, a normal charge still adds
 * exactly one month, and the plan mismatch behaves exactly as before.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real) -- web/CLAUDE.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The subscriber. */
let student: string;

const RZP_SUB = 'sub_test_000000000001';

/** A Razorpay subscription id we have no row for at all. */
const UNKNOWN_SUB = 'sub_test_never_seen_00';

/** Every kind 0035 allowed, which 0039 must keep. */
const OLD_KINDS = [
  'no_purchase',
  'not_paid',
  'amount_mismatch',
  'no_payment',
  'currency_mismatch',
  'plan_mismatch',
  'bad_event',
  'unreadable_purchase',
] as const;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** `subscription.charged`, the way the webhook delivers it: ONE call. */
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

function markStatus(rzpId: string, status: string) {
  return db.admin
    .query<{ marked: boolean }>('select public.mark_subscription($1, $2) as marked', [
      rzpId,
      status,
    ])
    .then((r) => r.rows[0].marked);
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
       from public.reconcile_alerts order by kind, subject`,
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

/** Days from now until the plan runs out. One month is about 30 or 31. */
async function planDays(plan = 'ai') {
  const res = await db.admin.query<{ days: number | null }>(
    `select round(extract(epoch from (valid_until - now())) / 86400)::int as days
     from public.entitlements where user_id = $1 and plan = $2`,
    [student, plan],
  );
  return res.rows[0]?.days ?? null;
}

function recordAlert(kind: string, subject: string) {
  return db.admin
    .query<{ fresh: boolean }>('select public.record_reconcile_alert($1, $2) as fresh', [
      kind,
      subject,
    ])
    .then((r) => r.rows[0].fresh);
}

// --------------------------------------------------------------------------

beforeAll(async () => {
  db = await createTestDb();
  student = await db.createUser();
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.payment_events');
  await db.admin.query('delete from public.reconcile_alerts');
  await db.admin.query('delete from public.entitlements');
  await db.admin.query('delete from public.subscriptions');
});

describe('the migration', () => {
  it('is applied after 0035, which held the old kind list', () => {
    expect(db.migrations).toContain('0039_charge_alerts.sql');
    expect(db.migrations.indexOf('0039_charge_alerts.sql')).toBeGreaterThan(
      db.migrations.indexOf('0035_reconcile_visible.sql'),
    );
  });

  it('still accepts all eight kinds 0035 allowed', async () => {
    for (const kind of OLD_KINDS) {
      await expect(recordAlert(kind, 'subject_' + kind)).resolves.toBe(true);
    }
  });

  it('accepts the two new kinds', async () => {
    await expect(recordAlert('unknown_subscription', 'charged:pay_a')).resolves.toBe(true);
    await expect(recordAlert('cancelled_subscription', 'charged:pay_b')).resolves.toBe(true);
  });

  it('still refuses a kind that is not on the list', async () => {
    await expect(recordAlert('unknown_subscrption', 'charged:pay_typo')).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// 1. An id we have no row for
// --------------------------------------------------------------------------

describe('a charge for a subscription we do not know', () => {
  it('files exactly one unknown_subscription alert and adds no month', async () => {
    expect(await charge({ rzpId: UNKNOWN_SUB, key: 'charged:pay_ghost' })).toBe(false);

    const filed = await alerts();
    expect(filed).toHaveLength(1);
    expect(filed[0].kind).toBe('unknown_subscription');
    expect(filed[0].subject).toBe('charged:pay_ghost');

    expect(await planDays('ai')).toBeNull();
    expect(await planDays('pro')).toBeNull();
  });

  it('keeps the de-dupe row, so the retry is still dropped', async () => {
    expect(await charge({ rzpId: UNKNOWN_SUB, key: 'charged:pay_ghost' })).toBe(false);

    // The ordering of 0034 is unchanged: the key is committed before the
    // refusal, which is exactly why the alert has to exist.
    expect(await storedEvents()).toEqual([
      { event_id: 'charged:pay_ghost', type: 'subscription.charged' },
    ]);
  });

  it('files no second alert when the same key is delivered twice', async () => {
    expect(await charge({ rzpId: UNKNOWN_SUB, key: 'charged:pay_ghost' })).toBe(false);
    expect(await charge({ rzpId: UNKNOWN_SUB, key: 'charged:pay_ghost' })).toBe(false);

    expect(await alerts()).toHaveLength(1);
    expect(await storedEvents()).toHaveLength(1);
  });

  it('names the subscription when the caller de-dupes itself', async () => {
    expect(await charge({ rzpId: UNKNOWN_SUB, key: null })).toBe(false);

    const filed = await alerts();
    expect(filed).toHaveLength(1);
    expect(filed[0].kind).toBe('unknown_subscription');
    expect(filed[0].subject).toBe('sub:' + UNKNOWN_SUB);
  });

  it('files nothing at all for an empty subscription id', async () => {
    expect(await charge({ rzpId: '', key: 'charged:pay_empty' })).toBe(false);
    expect(await alerts()).toEqual([]);
    expect(await storedEvents()).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 2. A charge that lands after the student stopped
// --------------------------------------------------------------------------

describe('a charge for a cancelled subscription', () => {
  beforeEach(async () => {
    await liveSubscription('ai');
  });

  it('files a cancelled_subscription alert and adds no month', async () => {
    expect(await markStatus(RZP_SUB, 'cancelled')).toBe(true);

    expect(await charge({ key: 'charged:pay_late' })).toBe(false);

    const filed = await alerts();
    expect(filed).toHaveLength(1);
    expect(filed[0].kind).toBe('cancelled_subscription');
    expect(filed[0].subject).toBe('charged:pay_late');
    expect(await planDays('ai')).toBeNull();
  });

  it('leaves a month already paid for exactly where it was', async () => {
    expect(await charge({ key: 'charged:pay_month_1' })).toBe(true);
    const paid = await planDays('ai');
    await markStatus(RZP_SUB, 'cancelled');

    expect(await charge({ key: 'charged:pay_late' })).toBe(false);
    expect(await planDays('ai')).toBe(paid);
    expect((await alerts())[0].kind).toBe('cancelled_subscription');
  });

  it('files no second alert when the same key is delivered twice', async () => {
    await markStatus(RZP_SUB, 'cancelled');

    expect(await charge({ key: 'charged:pay_late' })).toBe(false);
    expect(await charge({ key: 'charged:pay_late' })).toBe(false);

    expect(await alerts()).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// 3. Nothing else moved
// --------------------------------------------------------------------------

describe('the charges that already worked', () => {
  beforeEach(async () => {
    await liveSubscription('ai');
  });

  it('still adds exactly one month for a normal charge, with no alert', async () => {
    expect(await charge({ key: 'charged:pay_ok', plan: 'ai' })).toBe(true);

    expect(await planDays('ai')).toBeGreaterThanOrEqual(28);
    expect(await planDays('ai')).toBeLessThanOrEqual(32);
    expect(await alerts()).toEqual([]);
  });

  it('still answers FALSE for a repeat, and adds no second month', async () => {
    expect(await charge({ key: 'charged:pay_ok' })).toBe(true);
    const after = await planDays('ai');

    expect(await charge({ key: 'charged:pay_ok' })).toBe(false);
    expect(await planDays('ai')).toBe(after);
    expect(await alerts()).toEqual([]);
  });

  it('still files plan_mismatch, not one of the new kinds', async () => {
    expect(await charge({ key: 'charged:pay_wrong', plan: 'pro' })).toBe(false);

    const filed = await alerts();
    expect(filed).toHaveLength(1);
    expect(filed[0].kind).toBe('plan_mismatch');
    expect(filed[0].subject).toBe('charged:pay_wrong');
  });

  it('prefers plan_mismatch over cancelled when both are true', async () => {
    // The plan check is the first gate 0034 put in, and it stays first: a
    // charge for the wrong plan is a gateway configuration problem whatever
    // the status of our row says.
    await markStatus(RZP_SUB, 'cancelled');

    expect(await charge({ key: 'charged:pay_both', plan: 'pro' })).toBe(false);
    expect((await alerts())[0].kind).toBe('plan_mismatch');
  });
});
