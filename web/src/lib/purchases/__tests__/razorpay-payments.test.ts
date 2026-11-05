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
      {
        paymentId: 'pay_1',
        orderId: 'order_1',
        amountPaise: 39_900,
        status: 'captured',
        // Null, not missing: a one-off set sale has neither, and the nightly
        // reconcile reads both to tell a plan charge apart from a sale
        // (issue 35-reconcile-visible).
        invoiceId: null,
        subscriptionId: null,
      },
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
 * The nightly reconcile's read (issue 29-ledger-reconcile-payouts).
 *
 * This is the only call that reads payments we may know NOTHING about, so two
 * things matter more here than anywhere else:
 *
 *  * it must page to the end. A window that silently stopped at 100 payments
 *    would hide exactly the mismatch the job exists to find.
 *  * a failed page must THROW, not return what it has. A half-read window
 *    makes every unseen payment look like a sale the gateway never captured,
 *    and the job would file alerts about real, finished sales.
 */
describe('listPayments', () => {
  /** A fetch that answers a different page each call. */
  function pager(pages: readonly unknown[]) {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const page = pages[calls.length];
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return page;
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function page(count: number, from = 0) {
    return {
      items: Array.from({ length: count }, (_, index) => ({
        id: 'pay_' + (from + index),
        order_id: 'order_' + (from + index),
        amount: 39_900,
        status: 'captured',
      })),
    };
  }

  it('asks for the window in whole seconds and reads one short page', async () => {
    const { calls, fetchImpl } = pager([page(2)]);
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    const found = await payments.listPayments({ fromSeconds: 1_000, toSeconds: 2_000 });

    expect(found).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/payments?from=1000&to=2000');
    expect(calls[0]).toContain('skip=0');
    // The secret travels in a header, never in the URL.
    expect(calls[0]).not.toContain('shhh');
  });

  it('pages to the end, so a busy night is not truncated', async () => {
    const { calls, fetchImpl } = pager([page(100), page(100, 100), page(7, 200)]);
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    const found = await payments.listPayments({ fromSeconds: 0, toSeconds: 1 });

    expect(found).toHaveLength(207);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('skip=100');
    expect(calls[2]).toContain('skip=200');
  });

  it('drops a row it cannot read rather than inventing a captured payment', async () => {
    const { fetchImpl } = pager([
      {
        items: [
          { id: 'pay_1', order_id: 'order_1', amount: 39_900, status: 'captured' },
          { id: 'pay_2', order_id: 'order_2', amount: 'lots', status: 'captured' },
        ],
      },
    ]);
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.listPayments({ fromSeconds: 0, toSeconds: 1 })).resolves.toEqual([
      {
        paymentId: 'pay_1',
        orderId: 'order_1',
        amountPaise: 39_900,
        status: 'captured',
        // Null, not missing: a one-off set sale has neither, and the nightly
        // reconcile reads both to tell a plan charge apart from a sale
        // (issue 35-reconcile-visible).
        invoiceId: null,
        subscriptionId: null,
      },
    ]);
  });

  it('keeps a payment with no order id: that is the worst case, not a bad row', async () => {
    const { fetchImpl } = pager([
      { items: [{ id: 'pay_loose', amount: 29_900, status: 'captured' }] },
    ]);
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.listPayments({ fromSeconds: 0, toSeconds: 1 })).resolves.toEqual([
      {
        paymentId: 'pay_loose',
        orderId: null,
        amountPaise: 29_900,
        status: 'captured',
        invoiceId: null,
        subscriptionId: null,
      },
    ]);
  });

  it('throws on a failed page instead of answering a half window', async () => {
    const { fetchImpl } = recorder({}, false, 502);
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.listPayments({ fromSeconds: 0, toSeconds: 1 })).rejects.toThrow(
      'Razorpay payments list failed with status 502',
    );
  });

  it('refuses a backwards window without calling Razorpay', async () => {
    const { calls, fetchImpl } = recorder({ items: [] });
    const payments = createRazorpayPayments({ env: ENV, fetchImpl });

    await expect(payments.listPayments({ fromSeconds: 2_000, toSeconds: 1_000 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses when there are no keys, so a missing key is never a quiet night', async () => {
    const payments = createRazorpayPayments({ env: {} });
    await expect(payments.listPayments({ fromSeconds: 0, toSeconds: 1 })).rejects.toThrow();
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
