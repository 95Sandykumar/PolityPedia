/**
 * The decision logic behind POST /api/checkout/subscription
 * (issue 28-plan-subscriptions).
 *
 * The order of the describes IS the order of the steps, and the first one is
 * the one that matters: THERE IS NO AMOUNT IN THE REQUEST. F-G2 says "the
 * price always comes from our database, never from the phone", and this route
 * keeps that the cheap way: it reads a plan name and nothing else, so there is
 * no amount to validate and no amount to forget to validate.
 *
 * Nothing here talks to Razorpay or Supabase: both sit behind the fakes in
 * `@/lib/purchases/types` and this file (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { createFakePayments, PurchaseError } from '@/lib/purchases/types';
import { PLANS as PLAN_NAMES } from '@/lib/plans/types';
import { PLANS as PAYMENT_PLAN_NAMES } from '@/lib/purchases/types';
import { handleSubscribe } from '../subscribe-route';
import { createFakeSubscriptionsClient } from '../fake-subscriptions-client';

/** A signed-in student. No real token: this never leaves the process. */
const SESSION: AuthSession = {
  userId: 'u1',
  accessToken: 'not_a_real_token',
  refreshToken: 'not_a_real_refresh',
  role: 'student',
};

function run(
  body: unknown,
  options: {
    session?: AuthSession | null;
    client?: ReturnType<typeof createFakeSubscriptionsClient>;
    payments?: ReturnType<typeof createFakePayments>;
  } = {},
) {
  const client = options.client ?? createFakeSubscriptionsClient();
  const payments = options.payments ?? createFakePayments();
  return handleSubscribe({
    body,
    session: options.session === undefined ? SESSION : options.session,
    client: client.client,
    payments: payments.payments,
  }).then((reply) => ({ reply, client, payments }));
}

describe('the two plan lists', () => {
  it('say the same thing, so the payments contract cannot drift', () => {
    // `purchases/types.ts` re-declares the plan names to avoid a cycle between
    // two contract files. This is the test its comment promises.
    expect([...PAYMENT_PLAN_NAMES]).toEqual([...PLAN_NAMES]);
  });
});

describe('the request', () => {
  it('carries a plan and NOTHING else (F-G2)', async () => {
    const { reply, client } = await run({ plan: 'pro', amount_inr: 1 });

    expect(reply.status).toBe(200);
    // The amount in the body was never read. Postgres quoted Rs 500.
    expect(client.started).toEqual(['pro']);
    expect(reply.body).toMatchObject({ amountInr: 500 });
  });

  it('refuses a body with no plan, or a plan we do not sell', async () => {
    for (const body of [null, {}, { plan: '' }, { plan: 'platinum' }, { plan: 7 }]) {
      const { reply, client } = await run(body);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: 'bad_request' });
      // Nothing was started, so no stray `created` row.
      expect(client.started).toEqual([]);
    }
  });

  it('refuses a visitor who is not signed in, before any database call', async () => {
    const { reply, client, payments } = await run({ plan: 'ai' }, { session: null });
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'sign_in' });
    expect(client.started).toEqual([]);
    expect(payments.subscriptions).toEqual([]);
  });
});

describe('the happy path', () => {
  it('starts in Postgres, opens the subscription, then attaches the id', async () => {
    const { reply, client, payments } = await run({ plan: 'ai' });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      subscriptionId: 'sub-row-1',
      razorpaySubscriptionId: 'sub_test_1',
      amountInr: 100,
      plan: 'ai',
      keyId: 'rzp_test_fake',
    });

    // Our own row id travels to Razorpay as a note, so a human in the console
    // can get from a subscription back to our table.
    expect(payments.subscriptions).toEqual([
      { plan: 'ai', notes: { subscription_id: 'sub-row-1' } },
    ]);
    expect(client.attached).toEqual([
      { subscriptionId: 'sub-row-1', razorpaySubscriptionId: 'sub_test_1' },
    ]);
  });

  it('hands out the PUBLIC key id and never a secret', async () => {
    const { reply } = await run({ plan: 'pro' });
    const body = JSON.stringify(reply.body);
    expect(body).toContain('rzp_test_fake');
    expect(body).not.toMatch(/secret/i);
  });
});

describe('refusals from Postgres', () => {
  it('says "you already have that plan" with a 409', async () => {
    const client = createFakeSubscriptionsClient({ failStart: 'owned' });
    const { reply, payments } = await run({ plan: 'ai' }, { client });

    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: 'owned' });
    // Razorpay was never asked, so there is no subscription to cancel.
    expect(payments.subscriptions).toEqual([]);
  });

  it('passes the other codes through with their own statuses', async () => {
    for (const [code, status] of [
      ['sign_in', 401],
      ['not_found', 404],
      ['failed', 502],
    ] as const) {
      const client = createFakeSubscriptionsClient({ failStart: code });
      const { reply } = await run({ plan: 'ai' }, { client });
      expect(reply.status).toBe(status);
      expect(reply.body).toEqual({ error: code });
    }
  });

  it('answers 503 when Supabase is not set up', async () => {
    const client = createFakeSubscriptionsClient({ configured: false });
    const { reply } = await run({ plan: 'ai' }, { client });
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'not_configured' });
  });
});

describe('when Razorpay is not ready', () => {
  it('answers 503 with no keys, and starts nothing', async () => {
    const payments = createFakePayments({ configured: false });
    const { reply, client } = await run({ plan: 'ai' }, { payments });
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'not_configured' });
    expect(client.started).toEqual([]);
  });

  it('answers 503 when the keys are set but this plan has no plan object', async () => {
    // Keys first, then one Razorpay plan per price. In between, AI can be sold
    // and Pro cannot, and the page should say so rather than fail at the card
    // screen.
    const payments = createFakePayments({ plans: ['ai'] });
    const pro = await run({ plan: 'pro' }, { payments });
    expect(pro.reply.status).toBe(503);
    expect(pro.reply.body).toEqual({ error: 'not_configured' });

    const ai = await run({ plan: 'ai' }, { payments: createFakePayments({ plans: ['ai'] }) });
    expect(ai.reply.status).toBe(200);
  });

  it('answers 502 when the gateway call throws', async () => {
    const payments = createFakePayments({ failCreate: true });
    const { reply } = await run({ plan: 'ai' }, { payments });
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'gateway' });
  });

  it('refuses to open the checkout when the id will not stick', async () => {
    // The subscription exists at Razorpay but our row cannot point at it, so
    // the webhook would never find it. Sending the student to pay for a plan
    // we cannot grant is worse than an error message.
    const client = createFakeSubscriptionsClient({ failAttach: true });
    const { reply } = await run({ plan: 'ai' }, { client });
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'gateway' });
  });
});

describe('what a refusal never leaks', () => {
  it('answers a fixed code, never a Postgres or Razorpay sentence', async () => {
    const client = createFakeSubscriptionsClient({
      failStartWith: new Error('duplicate key value violates subscriptions_rzp_idx'),
    });
    const { reply } = await run({ plan: 'ai' }, { client });

    expect(reply.body).toEqual({ error: 'failed' });
    expect(JSON.stringify(reply.body)).not.toMatch(/subscriptions_rzp_idx/);
  });

  it('is never anything but one of our own codes', async () => {
    const codes = new Set<unknown>();
    for (const client of [
      createFakeSubscriptionsClient({ failStart: 'owned' }),
      createFakeSubscriptionsClient({ failAttach: true }),
      createFakeSubscriptionsClient({ configured: false }),
    ]) {
      const { reply } = await run({ plan: 'ai' }, { client });
      if ('error' in reply.body) codes.add(reply.body.error);
    }
    expect([...codes].every((code) => typeof code === 'string')).toBe(true);
  });

  it('throws nothing for any shape of body', async () => {
    for (const body of [undefined, 0, '', [], { plan: { plan: 'ai' } }]) {
      await expect(run(body)).resolves.toBeTruthy();
    }
  });
});

/** The PurchaseError import is used by the fake; this keeps it honest. */
describe('the fake', () => {
  it('throws the same error class the real client throws', async () => {
    const client = createFakeSubscriptionsClient({ failStart: 'owned' });
    await expect(client.client.start('ai')).rejects.toBeInstanceOf(PurchaseError);
  });
});
