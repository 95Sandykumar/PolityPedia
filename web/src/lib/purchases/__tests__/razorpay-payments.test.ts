/**
 * The real Razorpay client (issue 26-razorpay-order-checkout).
 *
 * `fetch` is injected, so there is no network call and no real key in this
 * file (web/CLAUDE.md). What is checked:
 *
 *  * no keys -> `isConfigured()` is false and `keyId()` is null, so a build
 *    and a test run with NO environment variables still work,
 *  * the secret travels in a HEADER and never in a URL,
 *  * `keyId()` hands out the public half only,
 *  * rupees become paise exactly once,
 *  * a reply we cannot read is a failure, never a made-up order id.
 */
import { describe, expect, it } from 'vitest';
import {
  createRazorpayPayments,
  readRazorpayEnv,
  readRazorpayPlanId,
} from '../razorpay-payments';

const ENV = { RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'shhh_secret' };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recorder(reply: unknown, ok = true, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      async json() {
        return reply;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('configuration', () => {
  it('is not configured with no environment variables', () => {
    const payments = createRazorpayPayments({ env: {} });
    expect(payments.isConfigured()).toBe(false);
    expect(payments.keyId()).toBeNull();
    expect(readRazorpayEnv({})).toBeNull();
  });

  it('needs both halves of the key', () => {
    expect(readRazorpayEnv({ RAZORPAY_KEY_ID: 'rzp_test_abc' })).toBeNull();
    expect(readRazorpayEnv({ RAZORPAY_KEY_SECRET: 'shhh' })).toBeNull();
  });

  it('hands out the public key id and never the secret', () => {
    const payments = createRazorpayPayments({ env: ENV });
    expect(payments.isConfigured()).toBe(true);
    expect(payments.keyId()).toBe('rzp_test_abc');
    expect(JSON.stringify(payments.keyId())).not.toContain('shhh');
  });
});

describe('createOrder', () => {
  it('sends paise, our receipt and INR, with the secret in a header', async () => {
    const { calls, fetchImpl } = recorder({
      id: 'order_live_like',
      amount: 39_900,
      currency: 'INR',
    });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    const order = await payments.createOrder({
      amountInr: 399,
      receipt: '55555555-5555-4555-8555-555555555555',
    });

    expect(order).toEqual({ orderId: 'order_live_like', amountPaise: 39_900, currency: 'INR' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
    // The secret is never in the URL, where it would reach an access log.
    expect(calls[0].url).not.toContain('shhh');

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization.startsWith('Basic ')).toBe(true);

    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      amount: 39_900,
      currency: 'INR',
      receipt: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('refuses an amount of zero: that is the A4 path, not a gateway call', async () => {
    const { calls, fetchImpl } = recorder({ id: 'order_1', amount: 0, currency: 'INR' });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.createOrder({ amountInr: 0, receipt: 'r' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('throws with the status and no response body on a failure', async () => {
    const { fetchImpl } = recorder({ error: { description: 'key is wrong: shhh_secret' } }, false, 401);
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.createOrder({ amountInr: 399, receipt: 'r' })).rejects.toThrow(
      /status 401/,
    );
    await expect(payments.createOrder({ amountInr: 399, receipt: 'r' })).rejects.not.toThrow(
      /shhh/,
    );
  });

  it('refuses a reply it cannot read instead of inventing an order id', async () => {
    const { fetchImpl } = recorder({ amount: 39_900, currency: 'INR' });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.createOrder({ amountInr: 399, receipt: 'r' })).rejects.toThrow();
  });

  it('throws rather than calling anything when there are no keys', async () => {
    const { calls, fetchImpl } = recorder({});
    const payments = createRazorpayPayments({ env: {}, fetchImpl });

    await expect(payments.createOrder({ amountInr: 399, receipt: 'r' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('fetchPayments', () => {
  it('reads the payments of one order and drops a row it cannot read', async () => {
    const { calls, fetchImpl } = recorder({
      items: [
        { id: 'pay_1', order_id: 'order_1', amount: 39_900, status: 'captured' },
        { id: 'pay_2', order_id: 'order_1', amount: 'lots', status: 'captured' },
        { order_id: 'order_1', amount: 39_900, status: 'captured' },
      ],
    });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    const found = await payments.fetchPayments('order_1');

    expect(found).toEqual([
      { paymentId: 'pay_1', orderId: 'order_1', amountPaise: 39_900, status: 'captured' },
    ]);
    expect(calls[0].url).toContain('/orders/order_1/payments');
  });

  it('answers an empty list when the order has no payments', async () => {
    const { fetchImpl } = recorder({ count: 0, items: [] });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });
    await expect(payments.fetchPayments('order_1')).resolves.toEqual([]);
  });
});

/**
 * Subscriptions (issue 28-plan-subscriptions).
 *
 * The rule worth a test of its own: there is NO AMOUNT in the request. A
 * Razorpay subscription bills against a PLAN OBJECT whose price lives in
 * Razorpay's console, so an amount here would be a second place a price could
 * disagree with `plan_price_inr()` (F-G2).
 */
const PLAN_ENV = {
  ...ENV,
  RAZORPAY_PLAN_AI_ID: 'plan_test_ai',
  RAZORPAY_PLAN_PRO_ID: 'plan_test_pro',
};

describe('the Razorpay plan ids', () => {
  it('are read lazily and are null when unset', () => {
    expect(readRazorpayPlanId('ai', {})).toBeNull();
    expect(readRazorpayPlanId('pro', { RAZORPAY_PLAN_PRO_ID: '  ' })).toBeNull();
    expect(readRazorpayPlanId('ai', PLAN_ENV)).toBe('plan_test_ai');
  });

  it('are what `hasPlan()` answers on, not the keys', () => {
    // Keys set, plan objects not made yet: a real state between two deploys.
    const halfWay = createRazorpayPayments({
      env: { ...ENV, RAZORPAY_PLAN_AI_ID: 'plan_test_ai' },
    });
    expect(halfWay.isConfigured()).toBe(true);
    expect(halfWay.hasPlan('ai')).toBe(true);
    expect(halfWay.hasPlan('pro')).toBe(false);

    // No keys at all: neither plan can be sold, whatever the plan ids say.
    const noKeys = createRazorpayPayments({
      env: { RAZORPAY_PLAN_AI_ID: 'plan_test_ai' },
    });
    expect(noKeys.hasPlan('ai')).toBe(false);
  });
});

describe('createSubscription', () => {
  it('sends the plan id and NO amount, with the secret in a header', async () => {
    const { calls, fetchImpl } = recorder({ id: 'sub_test_1', status: 'created' });
    const payments = createRazorpayPayments({ env: PLAN_ENV, fetchImpl });

    const made = await payments.createSubscription({
      plan: 'pro',
      notes: { subscription_id: 'row-1' },
    });

    expect(made).toEqual({ subscriptionId: 'sub_test_1', status: 'created' });
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/subscriptions');

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.plan_id).toBe('plan_test_pro');
    expect(body.notes).toEqual({ subscription_id: 'row-1' });
    // F-G2: nothing on the wire names a price.
    expect(body.amount).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('500');

    // The secret goes in a header, never in the URL.
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(calls[0].url).not.toContain('shhh');
  });

  it('refuses a plan with no Razorpay plan id, before any call', async () => {
    const { calls, fetchImpl } = recorder({ id: 'sub_test_1', status: 'created' });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.createSubscription({ plan: 'ai' })).rejects.toThrow(/no plan id/);
    expect(calls).toHaveLength(0);
  });

  it('throws the status and never the body on a non-2xx', async () => {
    const { fetchImpl } = recorder({ error: { description: 'plan not found' } }, false, 400);
    const payments = createRazorpayPayments({ env: PLAN_ENV, fetchImpl });

    await expect(payments.createSubscription({ plan: 'ai' })).rejects.toThrow(
      /Razorpay subscription failed with status 400/,
    );
  });

  it('treats a reply it cannot read as a failure, never a made-up id', async () => {
    for (const reply of [{}, { id: '' }, { id: 'sub_test_1' }, { status: 'created' }]) {
      const { fetchImpl } = recorder(reply);
      const payments = createRazorpayPayments({ env: PLAN_ENV, fetchImpl });
      await expect(payments.createSubscription({ plan: 'ai' })).rejects.toThrow(
        /could not be read/,
      );
    }
  });
});
