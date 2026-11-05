/**
 * The Razorpay webhook, before anything reaches Postgres
 * (issue 27-razorpay-webhook-ledger).
 *
 * A2: "Signature checked first." The order of these describes IS the order of
 * the checks, and the first test is the one that matters: a body with a wrong
 * signature must not touch the store AT ALL. Not a de-dupe insert, not a
 * lookup, nothing. Anybody on the internet can POST to this URL.
 *
 * Nothing here talks to Razorpay or to Supabase: the store is a fake, and the
 * signature is made with the same `signWebhookBody()` the verifier uses, with
 * a made-up secret (web/CLAUDE.md: no real key in any test).
 */
import { describe, expect, it } from 'vitest';
import {
  createFakeWebhookStore,
  handleRazorpayWebhook,
  readWebhookEvent,
  readWebhookSecret,
  signWebhookBody,
  verifyWebhookSignature,
} from '../webhook';

const SECRET = 'whsec_not_a_real_secret';

/** A `payment.captured` body shaped the way Razorpay sends one. */
function capturedBody(
  values: { orderId?: string; paymentId?: string; feePaise?: number; amountPaise?: number } = {},
) {
  return JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    contains: ['payment'],
    created_at: 1_793_906_552,
    payload: {
      payment: {
        entity: {
          id: values.paymentId ?? 'pay_test_1',
          order_id: values.orderId ?? 'order_test_1',
          amount: values.amountPaise ?? 39_900,
          fee: values.feePaise ?? 941,
          tax: 143,
          status: 'captured',
        },
      },
    },
  });
}

/** A `refund.processed` body: Razorpay sends the payment entity with it. */
function refundBody(orderId = 'order_test_1') {
  return JSON.stringify({
    entity: 'event',
    event: 'refund.processed',
    contains: ['refund', 'payment'],
    payload: {
      refund: { entity: { id: 'rfnd_test_1', payment_id: 'pay_test_1', amount: 39_900 } },
      payment: { entity: { id: 'pay_test_1', order_id: orderId, amount: 39_900 } },
    },
  });
}

function post(
  rawBody: string,
  options: {
    signature?: string | null;
    eventIdHeader?: string | null;
    secret?: string | null;
    store?: ReturnType<typeof createFakeWebhookStore>;
  } = {},
) {
  const store = options.store ?? createFakeWebhookStore();
  const secret = options.secret === undefined ? SECRET : options.secret;
  return handleRazorpayWebhook({
    rawBody,
    signature:
      options.signature === undefined
        ? signWebhookBody(rawBody, secret ?? SECRET)
        : options.signature,
    eventIdHeader: options.eventIdHeader ?? 'evt_test_1',
    secret,
    store: store.store,
  }).then((reply) => ({ reply, store }));
}

describe('the secret', () => {
  it('is read lazily from the environment, and is null when unset', () => {
    expect(readWebhookSecret({})).toBeNull();
    expect(readWebhookSecret({ RAZORPAY_WEBHOOK_SECRET: '   ' })).toBeNull();
    expect(readWebhookSecret({ RAZORPAY_WEBHOOK_SECRET: ' s3cret ' })).toBe('s3cret');
  });

  it('is not readable from a NEXT_PUBLIC name', () => {
    // A webhook secret in a NEXT_PUBLIC_ variable is inlined into the browser
    // bundle, and then anybody can forge a captured payment.
    expect(readWebhookSecret({ NEXT_PUBLIC_RAZORPAY_WEBHOOK_SECRET: 'oops' })).toBeNull();
  });
});

describe('A2: the signature is checked FIRST', () => {
  it('refuses a wrong signature with 400 and touches nothing', async () => {
    const { reply, store } = await post(capturedBody(), { signature: 'deadbeef' });

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'bad_signature' });
    expect(store.events).toEqual([]);
    expect(store.granted).toEqual([]);
    expect(store.refunded).toEqual([]);
  });

  it('refuses a missing signature header', async () => {
    const { reply, store } = await post(capturedBody(), { signature: null });
    expect(reply.status).toBe(400);
    expect(store.events).toEqual([]);
  });

  it('refuses a body that was edited after it was signed', async () => {
    const honest = capturedBody({ orderId: 'order_test_1' });
    const tampered = capturedBody({ orderId: 'order_someone_else' });

    const { reply, store } = await post(tampered, {
      signature: signWebhookBody(honest, SECRET),
    });

    expect(reply.status).toBe(400);
    expect(store.granted).toEqual([]);
  });

  it('refuses a signature made with another secret', async () => {
    const body = capturedBody();
    const { reply } = await post(body, {
      signature: signWebhookBody(body, 'whsec_a_different_secret'),
    });
    expect(reply.status).toBe(400);
  });

  it('answers 503 and touches nothing when we have no secret to check against', async () => {
    const { reply, store } = await post(capturedBody(), { secret: null, signature: 'anything' });
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'not_configured' });
    expect(store.events).toEqual([]);
  });

  it('verifies a good signature, and is not fooled by length or case', () => {
    const body = capturedBody();
    const good = signWebhookBody(body, SECRET);

    expect(verifyWebhookSignature(body, good, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, good.toUpperCase(), SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, good.slice(0, -2), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, good + '00', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'not hex at all', SECRET)).toBe(false);
  });
});

describe('reading the event', () => {
  it('takes the event id from the header Razorpay sends', () => {
    const event = readWebhookEvent(capturedBody(), 'evt_from_header');
    expect(event?.eventId).toBe('evt_from_header');
    expect(event?.type).toBe('payment.captured');
    expect(event?.action).toBe('grant');
    expect(event?.orderId).toBe('order_test_1');
  });

  it('builds an event id from the body when there is no header', () => {
    const event = readWebhookEvent(capturedBody({ paymentId: 'pay_xyz' }), null);
    // Deterministic, so the SAME delivery twice still de-dupes.
    expect(event?.eventId).toBe('payment.captured:pay_xyz');
  });

  it('turns the fee from paise into rupees to the paisa', () => {
    const event = readWebhookEvent(capturedBody({ feePaise: 941 }), 'evt_fee');
    expect(event?.feeInr).toBe(9.41);
  });

  it('reads a fee of zero, and a body with no fee at all, as zero', () => {
    expect(readWebhookEvent(capturedBody({ feePaise: 0 }), 'evt_a')?.feeInr).toBe(0);
    const noFee = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } },
    });
    expect(readWebhookEvent(noFee, 'evt_b')?.feeInr).toBe(0);
  });

  it('reads a refund as a refund', () => {
    const event = readWebhookEvent(refundBody('order_r1'), 'evt_refund');
    expect(event?.type).toBe('refund.processed');
    expect(event?.action).toBe('refund');
    expect(event?.orderId).toBe('order_r1');
  });

  it('reads an event we do not act on as "none", not as a grant', () => {
    const failed = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', status: 'failed' } } },
    });
    expect(readWebhookEvent(failed, 'evt_failed')?.action).toBe('none');
  });

  it('refuses a body that is not JSON, or has no event id to de-dupe on', () => {
    expect(readWebhookEvent('not json', 'evt_1')).toBeNull();
    expect(readWebhookEvent('[]', 'evt_1')).toBeNull();
    // No header and no payment id: nothing to key the de-dupe on.
    expect(readWebhookEvent(JSON.stringify({ event: 'payment.captured' }), null)).toBeNull();
  });
});

describe('a captured payment', () => {
  it('stores the event, then opens the set with the fee it reported', async () => {
    const { reply, store } = await post(capturedBody({ orderId: 'order_ok', feePaise: 941 }));

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(store.events).toEqual([
      { eventId: 'evt_test_1', type: 'payment.captured' },
    ]);
    expect(store.granted).toEqual([{ orderId: 'order_ok', feeInr: 9.41 }]);
    expect(store.refunded).toEqual([]);
  });

  it('keeps the whole body, so support and the reconcile can read it', async () => {
    const { store } = await post(capturedBody({ orderId: 'order_kept' }));
    expect(store.payloads).toHaveLength(1);
    expect((store.payloads[0] as { event?: string }).event).toBe('payment.captured');
  });
});

describe('A1: the same event twice', () => {
  it('answers 200 and does nothing the second time', async () => {
    const store = createFakeWebhookStore();
    const body = capturedBody({ orderId: 'order_twice' });

    const first = await post(body, { store });
    expect(first.reply.status).toBe(200);

    const second = await post(body, { store });
    expect(second.reply.status).toBe(200);
    expect(second.reply.body).toEqual({ ok: true });

    // ONE grant, from two deliveries of one event.
    expect(store.granted).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });
});

describe('a refund', () => {
  it('shuts the set and never grants', async () => {
    const { reply, store } = await post(refundBody('order_back'));

    expect(reply.status).toBe(200);
    expect(store.refunded).toEqual([{ orderId: 'order_back' }]);
    expect(store.granted).toEqual([]);
  });
});

describe('an event we do not act on', () => {
  it('is stored and answered 200, with no money moved', async () => {
    const failed = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_f', order_id: 'order_f', status: 'failed' } } },
    });
    const { reply, store } = await post(failed);

    expect(reply.status).toBe(200);
    expect(store.events).toHaveLength(1);
    expect(store.granted).toEqual([]);
    expect(store.refunded).toEqual([]);
  });
});

describe('when the database is unhappy', () => {
  it('answers 500 and releases the event id, so the retry can work', async () => {
    const store = createFakeWebhookStore({ failAction: true });
    const { reply } = await post(capturedBody({ orderId: 'order_boom' }), { store });

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: 'store' });
    // The event must NOT be left behind: Razorpay's next delivery would be
    // de-duped away and the student would have paid for a set that stays shut.
    expect(store.events).toEqual([]);
    expect(store.forgotten).toEqual(['evt_test_1']);
  });

  it('lets the retry succeed once the database is well again', async () => {
    const store = createFakeWebhookStore({ failAction: true });
    const body = capturedBody({ orderId: 'order_retry' });

    await post(body, { store });
    store.failAction(false);
    const { reply } = await post(body, { store });

    expect(reply.status).toBe(200);
    expect(store.granted).toEqual([{ orderId: 'order_retry', feeInr: 9.41 }]);
  });

  it('answers 503 when Supabase is not configured, after the signature passed', async () => {
    const store = createFakeWebhookStore({ configured: false });
    const { reply } = await post(capturedBody(), { store });
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'not_configured' });
  });
});

describe('a body we cannot read', () => {
  it('answers 400 for junk that is correctly signed', async () => {
    const { reply, store } = await post('not json at all');
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'bad_request' });
    expect(store.events).toEqual([]);
  });

  it('answers 200 for a captured payment with no order id, and moves nothing', async () => {
    // Razorpay can capture a payment that was not made against an order. It
    // is not ours, there is nothing to grant, and retrying forever is worse.
    const orphan = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_orphan', amount: 39_900, fee: 0 } } },
    });
    const { reply, store } = await post(orphan);

    expect(reply.status).toBe(200);
    expect(store.events).toHaveLength(1);
    expect(store.granted).toEqual([]);
  });
});
