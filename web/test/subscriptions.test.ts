/**
 * Plan subscriptions through Razorpay (issue 28-plan-subscriptions).
 *
 * V18 names three plans: Free, AI plan Rs 100/month, Pro Rs 500/month. Issue
 * 21 built `entitlements` and the `can_use()` gate, and left the writing of a
 * row to "an admin, or the Razorpay webhook in a later issue". This is that
 * later issue, and it is almost entirely Postgres for the same reason issue 27
 * was: a webhook arrives MORE THAN ONCE, and a route handler that reads,
 * decides and then writes has a gap in the middle where a student can end up
 * paying twice for one month, or losing a month they paid for.
 *
 * The four rules this file exists to prove:
 *
 *  * a `subscription.charged` event EXTENDS `entitlements.valid_until` by one
 *    month, stacking on what is already paid for rather than from `now()`,
 *  * a `subscription.cancelled` event leaves `valid_until` ALONE, so access
 *    runs out at the paid-until date and not the moment the card is dropped,
 *  * the SAME charged event delivered twice extends ONCE. The de-dupe is
 *    issue 27's `payment_events` table and `record_payment_event()`, driven
 *    here exactly the way `handleRazorpayWebhook()` drives it,
 *  * V19: NO teacher share on plan money. Not a small row, not a zero row.
 *    `teacher_ledger` stays empty, because a plan is not a teacher's sale.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The subscriber. */
let student: string;
/** Somebody else, to prove a subscription is not readable across accounts. */
let other: string;
/** The only user who may read every subscription by hand. */
let adminUser: string;

/** Razorpay's own id for a subscription. Test-mode shape. */
const RZP_SUB = 'sub_test_000000000001';

interface Started {
  subscription_id: string;
  amount_inr: number;
  status: string;
}

/** What the student's own token can do: start, then attach. */
async function start(plan: string, as: string = student): Promise<Started> {
  return db.asUser(as, async (sql) => {
    const res = await sql.query<Started>(`select * from public.start_plan_subscription($1)`, [
      plan,
    ]);
    return res.rows[0];
  });
}

async function attach(subscriptionId: string, rzpId: string, as: string = student) {
  return db.asUser(as, (sql) =>
    sql.query(`select public.attach_subscription_id($1, $2)`, [subscriptionId, rzpId]),
  );
}

/** A subscription that has been paid for once: exactly what the UI leaves. */
async function liveSubscription(plan = 'ai', rzpId = RZP_SUB) {
  const started = await start(plan);
  await attach(started.subscription_id, rzpId);
  return started;
}

/**
 * One webhook delivery, the way `handleRazorpayWebhook()` does it: de-dupe
 * FIRST, and only act when the event id is new (A1, A2).
 */
async function deliverCharged(eventId: string, rzpId = RZP_SUB): Promise<boolean> {
  const seen = await db.admin.query<{ record_payment_event: boolean }>(
    `select public.record_payment_event($1, 'subscription.charged', '{}'::jsonb)`,
    [eventId],
  );
  if (!seen.rows[0].record_payment_event) return false;

  const done = await db.admin.query<{ charge_subscription: boolean }>(
    `select public.charge_subscription($1)`,
    [rzpId],
  );
  return done.rows[0].charge_subscription;
}

async function mark(rzpId: string, status: string): Promise<boolean> {
  const res = await db.admin.query<{ mark_subscription: boolean }>(
    `select public.mark_subscription($1, $2)`,
    [rzpId, status],
  );
  return res.rows[0].mark_subscription;
}

/**
 * The stored plan, with `valid_until` as a NUMBER of epoch seconds.
 *
 * Not the timestamp itself: PGlite hands back a `Date`, and two Dates for the
 * same instant are different objects, so `toBe` would fail on a row that did
 * not move. A number is the thing the assertions actually mean.
 */
async function entitlement(plan = 'ai', user: string = student) {
  const res = await db.admin.query<{
    validUntil: number;
    source: string;
    days: number;
  }>(
    `select extract(epoch from valid_until)::float8 as "validUntil",
            source,
            -- Days between now and valid_until, so a test can say "about a
            -- month" without pinning a timestamp.
            round(extract(epoch from (valid_until - now())) / 86400)::int as days
     from public.entitlements
     where user_id = $1 and plan = $2`,
    [user, plan],
  );
  return res.rows[0] ?? null;
}

async function subscriptionRow(rzpId = RZP_SUB) {
  const res = await db.admin.query<{ status: string; plan: string; amount_inr: number }>(
    `select status, plan, amount_inr from public.subscriptions
     where razorpay_subscription_id = $1`,
    [rzpId],
  );
  return res.rows[0] ?? null;
}

async function count(table: string): Promise<number> {
  const res = await db.admin.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return res.rows[0].n;
}

beforeAll(async () => {
  db = await createTestDb();
  student = await db.createUser();
  other = await db.createUser();
  adminUser = await db.createUser();
  await db.admin.query(`update public.profiles set role = 'admin' where id = $1`, [adminUser]);
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.exec(`
    delete from public.payment_events;
    delete from public.entitlements;
    delete from public.subscriptions;
    delete from public.teacher_ledger;
  `);
});

describe('the migration', () => {
  it('is applied in number order and owns 0028', () => {
    expect(db.migrations).toContain('0028_subscriptions.sql');
  });
});

describe('the price', () => {
  it('is Rs 100 for the AI plan and Rs 500 for Pro (V18)', async () => {
    const res = await db.admin.query<{ ai: number; pro: number }>(
      `select public.plan_price_inr('ai') as ai, public.plan_price_inr('pro') as pro`,
    );
    expect(res.rows[0]).toEqual({ ai: 100, pro: 500 });
  });

  it('is null for anything that is not a plan, so a typo cannot be charged', async () => {
    const res = await db.admin.query<{ price: number | null }>(
      `select public.plan_price_inr('platinum') as price`,
    );
    expect(res.rows[0].price).toBeNull();
  });
});

describe('starting a subscription', () => {
  it('quotes the price from the database, never from the caller (F-G2)', async () => {
    const started = await start('ai');
    expect(started.amount_inr).toBe(100);
    expect(started.status).toBe('created');

    const pro = await start('pro');
    expect(pro.amount_inr).toBe(500);
  });

  it('refuses a visitor who is not signed in', async () => {
    await expect(
      db.asAnon((sql) => sql.query(`select * from public.start_plan_subscription('ai')`)),
    ).rejects.toThrow(/sign in/i);
  });

  it('refuses a plan that does not exist', async () => {
    await expect(start('platinum')).rejects.toThrow(/plan/i);
  });

  it('refuses a second subscription to a plan that is already active', async () => {
    const started = await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    expect((await subscriptionRow())?.status).toBe('active');
    expect(started.subscription_id).toBeTruthy();

    await expect(start('ai')).rejects.toThrow(/already/i);
    // A different plan is still allowed: no proration, no switching, but Pro
    // on top of AI is two rows and two bills, which is honest.
    await expect(start('pro')).resolves.toMatchObject({ amount_inr: 500 });
  });
});

describe('attaching the Razorpay id', () => {
  it('is single-shot, so one row can never point at two subscriptions (A1)', async () => {
    const started = await start('ai');
    await attach(started.subscription_id, RZP_SUB);
    await expect(attach(started.subscription_id, 'sub_test_000000000002')).rejects.toThrow();
  });

  it('refuses somebody else’s subscription row', async () => {
    const started = await start('ai');
    await expect(attach(started.subscription_id, RZP_SUB, other)).rejects.toThrow(/not found/i);
  });
});

describe('subscription.charged', () => {
  it('extends valid_until by one month and marks the row active', async () => {
    await liveSubscription('ai');
    expect(await deliverCharged('evt_charge_1')).toBe(true);

    const row = await entitlement('ai');
    expect(row).not.toBeNull();
    expect(row?.source).toBe('razorpay');
    // One month from now, to the day.
    expect(row?.days).toBeGreaterThanOrEqual(28);
    expect(row?.days).toBeLessThanOrEqual(31);

    expect((await subscriptionRow())?.status).toBe('active');
  });

  it('stacks on what is already paid for, not on now()', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    const first = await entitlement('ai');

    expect(await deliverCharged('evt_charge_2')).toBe(true);
    const second = await entitlement('ai');

    // Two months, not one: the second month starts where the first ended.
    expect(second?.days).toBeGreaterThan((first?.days ?? 0) + 25);
    expect(second!.validUntil).toBeGreaterThan(first!.validUntil);
  });

  it('does not extend twice for a replayed event (A1)', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    const once = await entitlement('ai');

    // The SAME delivery again. Razorpay retries until it gets a 2xx.
    expect(await deliverCharged('evt_charge_1')).toBe(false);

    const twice = await entitlement('ai');
    expect(twice?.validUntil).toBe(once?.validUntil);
  });

  it('answers false for a subscription that is not ours, and writes nothing', async () => {
    const res = await db.admin.query<{ charge_subscription: boolean }>(
      `select public.charge_subscription('sub_test_somebody_else')`,
    );
    expect(res.rows[0].charge_subscription).toBe(false);
    expect(await count('public.entitlements')).toBe(0);
  });

  it('restarts from now when the plan already ran out', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    // Pretend the month ran out a week ago and the retry only landed now.
    await db.admin.query(
      `update public.entitlements set valid_until = now() - interval '7 days'
       where user_id = $1 and plan = 'ai'`,
      [student],
    );

    await deliverCharged('evt_charge_2');
    const row = await entitlement('ai');
    // One month from today, NOT one month from a date in the past.
    expect(row?.days).toBeGreaterThanOrEqual(28);
  });

  it('resumes a halted subscription', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    await mark(RZP_SUB, 'halted');

    expect(await deliverCharged('evt_charge_2')).toBe(true);
    expect((await subscriptionRow())?.status).toBe('active');
  });

  it('does not extend a cancelled subscription', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    const before = await entitlement('ai');
    await mark(RZP_SUB, 'cancelled');

    expect(await deliverCharged('evt_charge_2')).toBe(false);
    expect((await entitlement('ai'))?.validUntil).toBe(before?.validUntil);
  });
});

describe('subscription.cancelled', () => {
  it('keeps access until the paid-until date', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    const paid = await entitlement('ai');

    expect(await mark(RZP_SUB, 'cancelled')).toBe(true);
    expect((await subscriptionRow())?.status).toBe('cancelled');

    // The row is untouched, so the gate is still open.
    expect((await entitlement('ai'))?.validUntil).toBe(paid?.validUntil);
    const open = await db.asUser(student, (sql) =>
      sql.query<{ ok: boolean }>(`select public.can_use($1, 'ai') as ok`, [student]),
    );
    expect(open.rows[0].ok).toBe(true);
  });

  it('shuts the gate once the paid month is over', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    await mark(RZP_SUB, 'cancelled');

    await db.admin.query(
      `update public.entitlements set valid_until = now() - interval '1 day'
       where user_id = $1 and plan = 'ai'`,
      [student],
    );

    const shut = await db.asUser(student, (sql) =>
      sql.query<{ ok: boolean }>(`select public.can_use($1, 'ai') as ok`, [student]),
    );
    expect(shut.rows[0].ok).toBe(false);
  });

  it('never reactivates a cancelled subscription', async () => {
    await liveSubscription('ai');
    await mark(RZP_SUB, 'cancelled');
    expect(await mark(RZP_SUB, 'active')).toBe(false);
    expect((await subscriptionRow())?.status).toBe('cancelled');
  });

  it('refuses a status that is not one of ours', async () => {
    await liveSubscription('ai');
    await expect(mark(RZP_SUB, 'refunded')).rejects.toThrow();
  });
});

describe('subscription.activated and subscription.halted', () => {
  it('activated marks the row live and grants nothing on its own', async () => {
    await liveSubscription('ai');
    expect(await mark(RZP_SUB, 'active')).toBe(true);
    expect((await subscriptionRow())?.status).toBe('active');
    // The money is `charged`, not `activated`. No month until it is paid.
    expect(await entitlement('ai')).toBeNull();
  });

  it('halted stops the next month but keeps the one already paid for', async () => {
    await liveSubscription('ai');
    await deliverCharged('evt_charge_1');
    const paid = await entitlement('ai');

    expect(await mark(RZP_SUB, 'halted')).toBe(true);
    expect((await subscriptionRow())?.status).toBe('halted');
    expect((await entitlement('ai'))?.validUntil).toBe(paid?.validUntil);
  });
});

describe('V19: no teacher share on plan money', () => {
  it('writes no ledger row and no payout for a charged plan', async () => {
    await liveSubscription('pro', 'sub_test_000000000009');
    await deliverCharged('evt_charge_1', 'sub_test_000000000009');

    expect((await entitlement('pro'))?.source).toBe('razorpay');
    // Not one row, not a zero row. A plan is not a teacher's sale.
    expect(await count('public.teacher_ledger')).toBe(0);
    expect(await count('public.payouts')).toBe(0);
    // And no mock-set purchase was invented either.
    expect(await count('public.purchases')).toBe(0);
  });
});

describe('RLS', () => {
  it('lets a student read only their own subscriptions', async () => {
    await liveSubscription('ai');

    const mine = await db.asUser(student, (sql) =>
      sql.query<{ n: number }>(`select count(*)::int as n from public.subscriptions`),
    );
    expect(mine.rows[0].n).toBe(1);

    const theirs = await db.asUser(other, (sql) =>
      sql.query<{ n: number }>(`select count(*)::int as n from public.subscriptions`),
    );
    expect(theirs.rows[0].n).toBe(0);

    const asAdmin = await db.asUser(adminUser, (sql) =>
      sql.query<{ n: number }>(`select count(*)::int as n from public.subscriptions`),
    );
    expect(asAdmin.rows[0].n).toBe(1);
  });

  it('gives a student no way to write a subscription row by hand', async () => {
    await expect(
      db.asUser(student, (sql) =>
        sql.query(
          `insert into public.subscriptions (user_id, plan, amount_inr, status)
           values ($1, 'pro', 1, 'active')`,
          [student],
        ),
      ),
    ).rejects.toThrow();
  });

  it('gives a student no way to call the webhook functions', async () => {
    // Free Pro for everybody if either of these is callable.
    await expect(
      db.asUser(student, (sql) => sql.query(`select public.charge_subscription($1)`, [RZP_SUB])),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(student, (sql) =>
        sql.query(`select public.mark_subscription($1, 'active')`, [RZP_SUB]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('gives a student no way to write their own entitlement', async () => {
    await expect(
      db.asUser(student, (sql) =>
        sql.query(
          `insert into public.entitlements (user_id, plan, valid_until, source)
           values ($1, 'pro', now() + interval '10 years', 'razorpay')`,
          [student],
        ),
      ),
    ).rejects.toThrow();
  });
});
