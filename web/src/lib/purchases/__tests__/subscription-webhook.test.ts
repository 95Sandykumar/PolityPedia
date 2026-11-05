/**
 * The webhook's subscription half (issue 28-plan-subscriptions).
 *
 * Issue 27 taught `handleRazorpayWebhook()` about a mock-set sale. A plan is
 * the same door with a different room behind it, and the issue says so: "Same
 * signature + de-dupe rules." So this file does not re-test the signature; it
 * tests that the four subscription events land on the right call and that plan
 * money never reaches the teacher ledger (V19).
 *
 *   subscription.activated -> mark active. GRANTS NOTHING.
 *   subscription.charged   -> one more month.
 *   subscription.cancelled -> mark cancelled. Access runs to valid_until.
 *   subscription.halted    -> mark halted. Same.
 *
 * Nothing here talks to Razorpay or Supabase: the store is the fake, and the
 * signature is made with the same `signWebhookBody()` the verifier uses, with
 * a made-up secret (web/CLAUDE.md: no real key in any test).
 */
import { describe, expect, it } from 'vitest';
import {
  createFakeWebhookStore,
  handleRazorpayWebhook,
  readWebhookEvent,
  signWebhookBody,
} from '../webhook';

const SECRET = 'whsec_not_a_real_secret';
const SUB = 'sub_test_000000000001';

/** A `subscription.charged` body: Razorpay sends payment AND subscription. */
function chargedBody(
  values: { subscriptionId?: string; paymentId?: string; orderId?: string } = {},
) {
  return JSON.stringify({
    entity: 'event',
    event: 'subscription.charged',
    contains: ['subscription', 'payment'],
    payload: {
      subscription: {
        entity: {
          id: values.subscriptionId ?? SUB,
          plan_id: 'plan_test_ai',
          status: 'active',
          paid_count: 1,
        },
      },
      payment: {
        entity: {
          id: values.paymentId ?? 'pay_test_sub_1',
          // A subscription charge DOES carry an order id of Razorpay's own
          // making. It is not one of ours, and the test below proves we never
          // treat it as a mock-set sale.
          order_id: values.orderId ?? 'order_rzp_sub_1',
          amount: 10_000,
          fee: 236,
          status: 'captured',
        },
      },
    },
  });
}

/** activated / cancelled / halted: the subscription entity on its own. */
function statusBody(event: string, subscriptionId = SUB) {
  return JSON.stringify({
    entity: 'event',
    event,
    contains: ['subscription'],
    payload: {
      subscription: { entity: { id: subscriptionId, plan_id: 'plan_test_ai' } },
    },
  });
}

function post(
  rawBody: string,
  options: {
    eventIdHeader?: string | null;
    store?: ReturnType<typeof createFakeWebhookStore>;
  } = {},
) {
  const store = options.store ?? createFakeWebhookStore();
  return handleRazorpayWebhook({
    rawBody,
    signature: signWebhookBody(rawBody, SECRET),
    eventIdHeader: options.eventIdHeader ?? 'evt_sub_1',
    secret: SECRET,
    store: store.store,
  }).then((reply) => ({ reply, store }));
}

describe('reading a subscription body', () => {
  it('finds the subscription id and the action', () => {
    const charged = readWebhookEvent(chargedBody(), 'evt_sub_1');
    expect(charged).toMatchObject({
      type: 'subscription.charged',
      action: 'charge_subscription',
      subscriptionId: SUB,
    });

    expect(readWebhookEvent(statusBody('subscription.activated'), null)).toMatchObject({
      action: 'mark_subscription',
      subscriptionStatus: 'active',
      subscriptionId: SUB,
    });
    expect(readWebhookEvent(statusBody('subscription.cancelled'), null)).toMatchObject({
      action: 'mark_subscription',
      subscriptionStatus: 'cancelled',
    });
    expect(readWebhookEvent(statusBody('subscription.halted'), null)).toMatchObject({
      action: 'mark_subscription',
      subscriptionStatus: 'halted',
    });
  });

  it('builds a de-dupe id per CHARGE, not per subscription', () => {
    // No `x-razorpay-event-id` header. The fallback must use the PAYMENT id,
    // because month two of the same subscription would otherwise carry the
    // same id as month one and be thrown away as a duplicate.
    const first = readWebhookEvent(chargedBody({ paymentId: 'pay_m1' }), null);
    const second = readWebhookEvent(chargedBody({ paymentId: 'pay_m2' }), null);
    expect(first?.eventId).not.toBe(second?.eventId);
    expect(first?.eventId).toContain('pay_m1');
  });

  it('falls back to the subscription id when there is no payment', () => {
    // activated / cancelled / halted happen once per subscription, so the
    // subscription id is a safe de-dupe key for them.
    const event = readWebhookEvent(statusBody('subscription.cancelled'), null);
    expect(event?.eventId).toBe('subscription.cancelled:' + SUB);
  });

  it('refuses a subscription body with no id at all', () => {
    const body = JSON.stringify({ event: 'subscription.charged', payload: {} });
    expect(readWebhookEvent(body, null)).toBeNull();
  });
});

describe('subscription.charged', () => {
  it('adds a month and never touches a purchase', async () => {
    const { reply, store } = await post(chargedBody());

    expect(reply.status).toBe(200);
    expect(store.charged).toEqual([{ subscriptionId: SUB }]);
    // V19: no teacher share on plan money. `grant_purchase()` is what writes
    // a ledger row, and it is not called, so there is no row to write.
    expect(store.granted).toEqual([]);
    expect(store.refunded).toEqual([]);
  });

  it('does not extend twice for a replayed delivery (A1)', async () => {
    const store = createFakeWebhookStore();
    const body = chargedBody();

    const first = await post(body, { store, eventIdHeader: 'evt_sub_1' });
    const second = await post(body, { store, eventIdHeader: 'evt_sub_1' });

    expect(first.reply.status).toBe(200);
    // 2xx so Razorpay stops retrying, and one charge, not two.
    expect(second.reply.status).toBe(200);
    expect(store.charged).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });

  it('stores no event id and asks for a retry when the store fails', async () => {
    const store = createFakeWebhookStore({ failAction: true });
    const { reply } = await post(chargedBody(), { store });

    expect(reply.status).toBe(500);
    // The month did not land, so the id must not make the retry a duplicate.
    // Since issue 34 the de-dupe row and the month are ONE transaction, so a
    // failed charge writes neither and there is nothing to release.
    expect(store.forgotten).toEqual([]);
    expect(store.events).toHaveLength(0);

    // The retry, with the store healthy again.
    store.failAction(false);
    const retry = await post(chargedBody(), { store });
    expect(retry.reply.status).toBe(200);
    expect(store.charged).toHaveLength(1);
  });
});

describe('subscription.activated, cancelled and halted', () => {
  it('marks the row and moves no money', async () => {
    const activated = await post(statusBody('subscription.activated'));
    expect(activated.reply.status).toBe(200);
    expect(activated.store.marked).toEqual([{ subscriptionId: SUB, status: 'active' }]);
    // The month is bought by `charged`. Activation alone grants nothing.
    expect(activated.store.charged).toEqual([]);

    const cancelled = await post(statusBody('subscription.cancelled'));
    expect(cancelled.store.marked).toEqual([{ subscriptionId: SUB, status: 'cancelled' }]);
    expect(cancelled.store.charged).toEqual([]);

    const halted = await post(statusBody('subscription.halted'));
    expect(halted.store.marked).toEqual([{ subscriptionId: SUB, status: 'halted' }]);
  });

  it('never writes a ledger row for any of them (V19)', async () => {
    for (const event of ['subscription.activated', 'subscription.cancelled', 'subscription.halted']) {
      const { store } = await post(statusBody(event));
      expect(store.granted).toEqual([]);
      expect(store.refunded).toEqual([]);
    }
  });
});

describe('what the subscription path does NOT do', () => {
  it('leaves a mock-set capture alone', async () => {
    // The sale path from issue 27 still works, and still goes to the ledger.
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_test_1', order_id: 'order_test_1', amount: 39_900, fee: 941 } },
      },
    });
    const { store } = await post(body);
    expect(store.granted).toEqual([{ orderId: 'order_test_1', feeInr: 9.41 }]);
    expect(store.charged).toEqual([]);
    expect(store.marked).toEqual([]);
  });

  it('never calls grant_purchase with a Razorpay subscription order id', async () => {
    // A subscription charge carries an `order_id` that is Razorpay's, not
    // ours. Treating it as a mock-set order would hunt for a purchase that
    // does not exist, and, worse, could match one if ids ever collided.
    const { store } = await post(chargedBody({ orderId: 'order_test_1' }));
    expect(store.granted).toEqual([]);
    expect(store.charged).toEqual([{ subscriptionId: SUB }]);
  });

  it('stores an unknown subscription event and does nothing with it', async () => {
    const { reply, store } = await post(statusBody('subscription.pending'));
    expect(reply.status).toBe(200);
    expect(store.events).toEqual([
      { eventId: 'evt_sub_1', type: 'subscription.pending' },
    ]);
    expect(store.charged).toEqual([]);
    expect(store.marked).toEqual([]);
  });
});
