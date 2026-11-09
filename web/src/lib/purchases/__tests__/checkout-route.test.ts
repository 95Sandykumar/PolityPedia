/**
 * POST /api/checkout/order (issue 26-razorpay-order-checkout).
 *
 * The two facts the definition of done names, written as tests:
 *
 *  1. F-G2 -- an amount in the REQUEST BODY is ignored. The order Razorpay is
 *             asked for carries the amount the DATABASE quoted, and nothing
 *             the phone sent.
 *  2. A4   -- a 100% coupon grants access with NO Payments call at all. The
 *             fake's `orders` list stays empty, which is the only proof that
 *             matters: a gateway call that "did not charge anything" is still
 *             a gateway call.
 *
 * Plus the paths a checkout has to get right or lose money: a refusal keeps
 * its own code, a gateway failure does not pretend to have sold anything, and
 * the browser is handed the PUBLIC key id and never a secret.
 *
 * Razorpay is `createFakePayments()` from `../types`, so there is no network
 * call and no key in this file (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { handleCheckoutOrder } from '../checkout-route';
import {
  createFakePayments,
  PurchaseError,
  type CheckoutClient,
  type PurchaseFailure,
  type StartPurchaseInput,
  type StartedPurchase,
} from '../types';

const SET = '22222222-2222-4222-8222-222222222222';
const PURCHASE = '55555555-5555-4555-8555-555555555555';

const session: AuthSession = {
  accessToken: 'token',
  refreshToken: 'refresh',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
};

interface FakeClientOptions {
  configured?: boolean;
  /** What `start_set_purchase()` answers. */
  started?: StartedPurchase;
  /** What it refuses with instead. */
  refuse?: PurchaseFailure;
  /** The order id a `pending` refusal carries (issue 61-block-second-order). */
  pendingOrderId?: string | null;
  failAttach?: boolean;
}

function fakeClient(options: FakeClientOptions = {}) {
  const starts: StartPurchaseInput[] = [];
  const attached: { purchaseId: string; orderId: string }[] = [];

  const client: CheckoutClient = {
    isConfigured() {
      return options.configured ?? true;
    },
    async start(input: StartPurchaseInput) {
      starts.push(input);
      if (options.refuse) throw new PurchaseError(options.refuse, options.pendingOrderId ?? null);
      return (
        options.started ?? { purchaseId: PURCHASE, amountInr: 399, status: 'created' as const }
      );
    },
    async attachOrderId(purchaseId: string, orderId: string) {
      attached.push({ purchaseId, orderId });
      if (options.failAttach) throw new Error('attach failed');
    },
  };

  return { client, starts, attached };
}

describe('F-G2: the price comes from our database', () => {
  it('ignores an amount in the request body', async () => {
    const { client, starts } = fakeClient({
      started: { purchaseId: PURCHASE, amountInr: 399, status: 'created' },
    });
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      // A patched browser asking to pay one rupee for a Rs 399 set.
      body: { set_id: SET, amount: 1, amount_inr: 1, amountPaise: 100, price_inr: 1 },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply.status).toBe(200);
    // Nothing from the body reached the database call.
    expect(starts).toEqual([{ setId: SET, coupon: null }]);
    // And the gateway was asked for the DATABASE's rupees, not the body's.
    expect(gateway.orders).toHaveLength(1);
    expect(gateway.orders[0].amountInr).toBe(399);
    expect(reply.body).toMatchObject({ free: false, amountPaise: 39_900 });
  });

  it('hands the browser the order and the PUBLIC key id only', async () => {
    const { client } = fakeClient();
    const gateway = createFakePayments({ keyId: 'rzp_test_public' });

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply.body).toEqual({
      free: false,
      purchaseId: PURCHASE,
      orderId: 'order_test_1',
      amountPaise: 39_900,
      currency: 'INR',
      keyId: 'rzp_test_public',
    });
    // No token, no secret, no Supabase anything.
    expect(JSON.stringify(reply.body)).not.toContain('token');
    expect(JSON.stringify(reply.body)).not.toContain('secret');
  });

  it('uses our purchase id as the Razorpay receipt, so the webhook can match', async () => {
    const { client, attached } = fakeClient();
    const gateway = createFakePayments();

    await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    expect(gateway.orders[0].receipt).toBe(PURCHASE);
    // A1: the order id is written back on our row, once.
    expect(attached).toEqual([{ purchaseId: PURCHASE, orderId: 'order_test_1' }]);
  });
});

describe('A4: a 100% coupon opens the set with no gateway call', () => {
  it('answers free and never touches Payments', async () => {
    const { client, starts } = fakeClient({
      started: { purchaseId: PURCHASE, amountInr: 0, status: 'paid' },
    });
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      body: { set_id: SET, coupon: ' free100 ' },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ free: true, purchaseId: PURCHASE });
    // THE assertion of this slice.
    expect(gateway.orders).toHaveLength(0);
    expect(gateway.fetched).toHaveLength(0);
    // The coupon reached the database trimmed and upper case.
    expect(starts).toEqual([{ setId: SET, coupon: 'FREE100' }]);
  });

  it('works even when Razorpay is not configured at all', async () => {
    const { client } = fakeClient({
      started: { purchaseId: PURCHASE, amountInr: 0, status: 'paid' },
    });
    const gateway = createFakePayments({ configured: false, keyId: null });

    const reply = await handleCheckoutOrder({
      body: { set_id: SET, coupon: 'FREE100' },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ free: true, purchaseId: PURCHASE });
  });

  it('does not treat an empty coupon box as a coupon', async () => {
    const { client, starts } = fakeClient();
    const gateway = createFakePayments();

    await handleCheckoutOrder({
      body: { set_id: SET, coupon: '   ' },
      session,
      client,
      payments: gateway.payments,
    });

    expect(starts[0].coupon).toBeNull();
  });
});

describe('refusals', () => {
  it('asks a visitor to sign in before any database call', async () => {
    const { client, starts } = fakeClient();
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session: null,
      client,
      payments: gateway.payments,
    });

    expect(reply).toEqual({ status: 401, body: { error: 'sign_in' } });
    expect(starts).toHaveLength(0);
    expect(gateway.orders).toHaveLength(0);
  });

  it('refuses a body with no set id', async () => {
    const { client, starts } = fakeClient();
    const gateway = createFakePayments();

    for (const body of [null, {}, { set_id: 'not-a-uuid' }, { set_id: 7 }, 'nope']) {
      const reply = await handleCheckoutOrder({
        body,
        session,
        client,
        payments: gateway.payments,
      });
      expect(reply).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(starts).toHaveLength(0);
    expect(gateway.orders).toHaveLength(0);
  });

  it('says so when Supabase is not configured', async () => {
    const { client, starts } = fakeClient({ configured: false });
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply).toEqual({ status: 503, body: { error: 'not_configured' } });
    expect(starts).toHaveLength(0);
  });

  it('keeps each database refusal as its own code', async () => {
    const cases: { refuse: PurchaseFailure; status: number }[] = [
      { refuse: 'not_found', status: 404 },
      { refuse: 'owned', status: 409 },
      { refuse: 'own_set', status: 403 },
      { refuse: 'coupon', status: 422 },
      { refuse: 'pending', status: 409 },
      { refuse: 'sign_in', status: 401 },
      { refuse: 'failed', status: 502 },
    ];

    for (const one of cases) {
      const { client } = fakeClient({ refuse: one.refuse });
      const gateway = createFakePayments();

      const reply = await handleCheckoutOrder({
        body: { set_id: SET, coupon: 'FREE100' },
        session,
        client,
        payments: gateway.payments,
      });

      expect(reply).toEqual({ status: one.status, body: { error: one.refuse } });
      expect(gateway.orders).toHaveLength(0);
    }
  });

  it('refuses a second order while a payment is pending, and calls no gateway', async () => {
    // Issue 61-block-second-order. The student tapped Unlock twice while
    // Razorpay was still confirming. One payment, so ONE order: a second
    // order here is a second charge.
    const { client } = fakeClient({ refuse: 'pending', pendingOrderId: 'order_pending_1' });
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    // The order id travels, so the UI can reopen the checkout they have.
    expect(reply).toEqual({
      status: 409,
      body: { error: 'pending', orderId: 'order_pending_1' },
    });
    expect(gateway.orders).toHaveLength(0);
  });

  it('still says pending when the second tap beat the Razorpay order', async () => {
    const { client } = fakeClient({ refuse: 'pending' });
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    // No order id to hand back, so the key is absent rather than null: the
    // UI shows the same sentence and simply has nothing to reopen.
    expect(reply).toEqual({ status: 409, body: { error: 'pending' } });
    expect(gateway.orders).toHaveLength(0);
  });

  it('refuses a paid order when Razorpay has no keys, instead of a half checkout', async () => {
    const { client } = fakeClient();
    const gateway = createFakePayments({ configured: false, keyId: null });

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply).toEqual({ status: 503, body: { error: 'not_configured' } });
    expect(gateway.orders).toHaveLength(0);
  });

  it('answers gateway when the Razorpay order fails', async () => {
    const { client, attached } = fakeClient();
    const gateway = createFakePayments({ failCreate: true });

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply).toEqual({ status: 502, body: { error: 'gateway' } });
    // Nothing was written back: there is no order id to write.
    expect(attached).toHaveLength(0);
  });

  it('answers gateway when the order id cannot be stored, and opens no checkout', async () => {
    // A1 lives in Postgres. If the order id will not stick, the webhook could
    // never find our row, so the student must NOT be sent to pay.
    const { client } = fakeClient({ failAttach: true });
    const gateway = createFakePayments();

    const reply = await handleCheckoutOrder({
      body: { set_id: SET },
      session,
      client,
      payments: gateway.payments,
    });

    expect(reply).toEqual({ status: 502, body: { error: 'gateway' } });
  });
});
