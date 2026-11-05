/**
 * The webhook's ORDER OF OPERATIONS (issue 34-webhook-grant-first).
 *
 * Issue 27 put the de-dupe FIRST: `record_payment_event()`, then the action,
 * in two separate round trips. The 2026-11-05 review found the hole in that:
 * a server killed between the two leaves the event id stored and the set shut,
 * so Razorpay's retry is a "duplicate" that does nothing and a student who
 * paid never gets in. `forget_payment_event()` was the fix, and it only runs
 * if the process is still alive to run it.
 *
 * So the order is now ACTION FIRST, AUDIT SECOND, and this file is the proof:
 *
 *  * the action is called before `recordEvent`, every time,
 *  * a crash after the action and before the audit row still leaves the set
 *    open, and the retry is a harmless no-op,
 *  * `subscription.charged` is ONE call that carries its own de-dupe key,
 *    built from the SIGNED body and never from the unsigned header,
 *  * an event that can NEVER succeed (an 81-character order id, a silly fee)
 *    is alerted and answered 200, not retried for hours behind a 500.
 *
 * Nothing here talks to Razorpay or Supabase: the store is the fake, and the
 * signature is made with the same `signWebhookBody()` the verifier uses, with
 * a made-up secret (web/CLAUDE.md: no real key in any test).
 */
import { describe, expect, it } from 'vitest';
import {
  WebhookPermanentError,
  createFakeWebhookStore,
  handleRazorpayWebhook,
  readWebhookEvent,
  signWebhookBody,
} from '../webhook';

const SECRET = 'whsec_not_a_real_secret';
const SUB = 'sub_test_000000000001';

function capturedBody(
  values: {
    orderId?: string;
    paymentId?: string;
    feePaise?: number;
    amountPaise?: number;
    currency?: string;
  } = {},
) {
  return JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: values.paymentId ?? 'pay_test_1',
          order_id: values.orderId ?? 'order_test_1',
          amount: values.amountPaise ?? 39_900,
          currency: values.currency ?? 'INR',
          fee: values.feePaise ?? 941,
          status: 'captured',
        },
      },
    },
  });
}

function chargedBody(values: { paymentId?: string; subscriptionId?: string } = {}) {
  return JSON.stringify({
    entity: 'event',
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: { id: values.subscriptionId ?? SUB, plan_id: 'plan_test_ai', status: 'active' },
      },
      payment: {
        entity: {
          id: values.paymentId ?? 'pay_test_sub_1',
          order_id: 'order_rzp_sub_1',
          amount: 10_000,
          currency: 'INR',
          fee: 236,
        },
      },
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
    eventIdHeader: options.eventIdHeader ?? 'evt_test_1',
    secret: SECRET,
    store: store.store,
  }).then((reply) => ({ reply, store }));
}

// --------------------------------------------------------------------------
// 1. Reading the new facts out of the signed body
// --------------------------------------------------------------------------

describe('reading the signed body', () => {
  it('takes the paid amount and the currency from the payment entity', () => {
    const event = readWebhookEvent(capturedBody({ amountPaise: 39_900 }), 'evt_1');
    expect(event).toMatchObject({ amountPaise: 39_900, currency: 'INR' });
  });

  it('reads an order.paid body, where the amount sits on the order', () => {
    const body = JSON.stringify({
      event: 'order.paid',
      payload: {
        order: { entity: { id: 'order_op', amount: 39_900, currency: 'INR' } },
        payment: { entity: { id: 'pay_op', order_id: 'order_op', fee: 941 } },
      },
    });
    expect(readWebhookEvent(body, 'evt_1')).toMatchObject({
      action: 'grant',
      orderId: 'order_op',
      amountPaise: 39_900,
      currency: 'INR',
    });
  });

  it('leaves the amount null when the gateway did not say', () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_q', order_id: 'order_q' } } },
    });
    expect(readWebhookEvent(body, 'evt_1')).toMatchObject({
      amountPaise: null,
      currency: null,
    });
  });

  it('builds the charge key from the PAYMENT id in the body, not the header', () => {
    const event = readWebhookEvent(chargedBody({ paymentId: 'pay_m7' }), 'evt_anything_at_all');
    expect(event?.chargeKey).toBe('charged:pay_m7');
    // The header still names the delivery, and is still not the charge key.
    expect(event?.eventId).toBe('evt_anything_at_all');
  });

  it('gives a non-charge event no charge key', () => {
    expect(readWebhookEvent(capturedBody(), 'evt_1')?.chargeKey).toBeNull();
    const cancelled = JSON.stringify({
      event: 'subscription.cancelled',
      payload: { subscription: { entity: { id: SUB } } },
    });
    expect(readWebhookEvent(cancelled, 'evt_1')?.chargeKey).toBeNull();
  });

  it('reads the Razorpay plan id off a charge, so the plan can be checked', () => {
    expect(readWebhookEvent(chargedBody(), 'evt_1')?.planId).toBe('plan_test_ai');
  });
});

// --------------------------------------------------------------------------
// 2. The action runs FIRST
// --------------------------------------------------------------------------

describe('the action runs before the audit row', () => {
  it('calls grantPurchase before recordEvent', async () => {
    const { reply, store } = await post(capturedBody({ orderId: 'order_ok' }));

    expect(reply.status).toBe(200);
    expect(store.calls).toEqual(['grantPurchase', 'recordEvent']);
  });

  it('calls refundPurchase before recordEvent', async () => {
    const body = JSON.stringify({
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } },
        payment: { entity: { id: 'pay_1', order_id: 'order_back', amount: 39_900 } },
      },
    });
    const { store } = await post(body);
    expect(store.calls).toEqual(['refundPurchase', 'recordEvent']);
  });

  it('calls markSubscription before recordEvent', async () => {
    const body = JSON.stringify({
      event: 'subscription.cancelled',
      payload: { subscription: { entity: { id: SUB } } },
    });
    const { store } = await post(body);
    expect(store.calls).toEqual(['markSubscription', 'recordEvent']);
  });

  it('runs the grant even when the same event id is already stored', async () => {
    // NO DE-DUPE GATE. The event id being known must not stop the idempotent
    // action: that is precisely the state a crash leaves behind.
    const store = createFakeWebhookStore();
    await store.store.recordEvent({
      eventId: 'evt_test_1',
      type: 'payment.captured',
      payload: {},
    });

    const { reply } = await post(capturedBody({ orderId: 'order_late' }), { store });

    expect(reply.status).toBe(200);
    expect(store.granted).toEqual([{ orderId: 'order_late', feeInr: 9.41 }]);
  });
});

// --------------------------------------------------------------------------
// 3. The crash the whole ticket is about
// --------------------------------------------------------------------------

describe('a crash between the action and the audit row', () => {
  it('leaves the set OPEN, and the retry is a harmless no-op', async () => {
    // The fake throws from `recordEvent` only: the grant has already landed,
    // which is exactly the state a killed process leaves in the database.
    const store = createFakeWebhookStore({ failRecord: true });
    const body = capturedBody({ orderId: 'order_crash' });

    const first = await post(body, { store });
    // 500 asks Razorpay to deliver again, and the retry is safe.
    expect(first.reply.status).toBe(500);
    // THE SET IS OPEN. The student is not locked out.
    expect(store.granted).toEqual([{ orderId: 'order_crash', feeInr: 9.41 }]);
    // Nothing was forgotten, because nothing had to be: there is no stored
    // event id standing in front of the retry.
    expect(store.forgotten).toEqual([]);

    // The retry, with the database well again.
    store.failRecord(false);
    const second = await post(body, { store });
    expect(second.reply.status).toBe(200);
    // ONE grant from two deliveries: `grant_purchase()` is idempotent.
    expect(store.granted).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });

  it('asks for a retry and stores NOTHING when the action itself fails', async () => {
    const store = createFakeWebhookStore({ failAction: true });
    const { reply } = await post(capturedBody({ orderId: 'order_boom' }), { store });

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: 'store' });
    expect(store.events).toEqual([]);
    // No compensating delete is needed any more: nothing was written first.
    expect(store.forgotten).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 4. subscription.charged is ONE call with its own key
// --------------------------------------------------------------------------

describe('subscription.charged is one call that carries its key', () => {
  it('passes the body-built key, and writes no second audit row', async () => {
    const { reply, store } = await post(chargedBody({ paymentId: 'pay_m1' }));

    expect(reply.status).toBe(200);
    expect(store.chargeKeys).toEqual(['charged:pay_m1']);
    // ONE row, and its id is the charge key: the insert and the month are the
    // same transaction, so there is no separate audit call to make.
    expect(store.events).toEqual([
      { eventId: 'charged:pay_m1', type: 'subscription.charged' },
    ]);
    expect(store.calls).toEqual(['chargeSubscription']);
  });

  it('adds nothing for the same body under a NEW header event id', async () => {
    const store = createFakeWebhookStore();
    const body = chargedBody({ paymentId: 'pay_m1' });

    await post(body, { store, eventIdHeader: 'evt_1' });
    const replay = await post(body, { store, eventIdHeader: 'evt_2_brand_new' });

    expect(replay.reply.status).toBe(200);
    // One month, not two. The header changed; the signed body did not.
    expect(store.charged).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });

  it('buys a real second month when the payment id is new', async () => {
    const store = createFakeWebhookStore();
    await post(chargedBody({ paymentId: 'pay_m1' }), { store, eventIdHeader: 'evt_1' });
    await post(chargedBody({ paymentId: 'pay_m2' }), { store, eventIdHeader: 'evt_2' });

    expect(store.chargeKeys).toEqual(['charged:pay_m1', 'charged:pay_m2']);
    expect(store.charged).toHaveLength(2);
  });

  it('passes the Razorpay plan id on, so the store can check it', async () => {
    const { store } = await post(chargedBody());
    expect(store.chargedPlans).toEqual(['plan_test_ai']);
  });

  it('alerts and answers 200 for a charge with no payment id to key on', async () => {
    // Nothing safe can be done with it: keying on the subscription id would
    // make month two a duplicate of month one. So it is stored, Boss is told,
    // and Razorpay is not asked to retry something that cannot work.
    const body = JSON.stringify({
      event: 'subscription.charged',
      payload: { subscription: { entity: { id: SUB, plan_id: 'plan_test_ai' } } },
    });
    const { reply, store } = await post(body);

    expect(reply.status).toBe(200);
    expect(store.charged).toEqual([]);
    expect(store.alerts).toEqual([
      {
        kind: 'bad_event',
        subject: 'charged:no-payment-id:evt_test_1',
        orderId: null,
        expectedPaise: null,
        actualPaise: null,
      },
    ]);
    expect(store.events).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// 5. Events that can never succeed
// --------------------------------------------------------------------------

describe('an event that can never succeed', () => {
  /** 81 characters: one more than `purchases_rzp_check` allows. */
  const TOO_LONG = 'order_' + 'x'.repeat(75);

  it('is stored, alerted and answered 200, never retried behind a 500', async () => {
    const store = createFakeWebhookStore({ failPermanently: true });
    const { reply } = await post(capturedBody({ orderId: TOO_LONG }), { store });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(store.granted).toEqual([]);
    expect(store.events).toHaveLength(1);
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0].kind).toBe('bad_event');
    // The subject names the delivery, so Boss can look it up.
    expect(store.alerts[0].subject).toContain('evt_test_1');
  });

  it('is told apart from a database that is merely unwell', async () => {
    // Same throw site, different error type, opposite answer: a transient
    // failure MUST get its retry.
    const unwell = createFakeWebhookStore({ failAction: true });
    const a = await post(capturedBody({ orderId: 'order_x' }), { store: unwell });
    expect(a.reply.status).toBe(500);
    expect(unwell.alerts).toEqual([]);

    const hopeless = createFakeWebhookStore({ failPermanently: true });
    const b = await post(capturedBody({ orderId: 'order_x' }), { store: hopeless });
    expect(b.reply.status).toBe(200);
    expect(hopeless.alerts).toHaveLength(1);
  });

  it('answers 200 even when the alert itself cannot be filed', async () => {
    // A failed alert must not turn into a retry storm: the event can never
    // succeed however many times it arrives.
    const store = createFakeWebhookStore({ failPermanently: true, failAlert: true });
    const { reply } = await post(capturedBody({ orderId: TOO_LONG }), { store });
    expect(reply.status).toBe(200);
  });

  it('carries a permanent error that the handler can recognise', () => {
    const boom = new WebhookPermanentError('the webhook needs an order id');
    expect(boom).toBeInstanceOf(Error);
    expect(boom.name).toBe('WebhookPermanentError');
  });
});
