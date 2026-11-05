/**
 * The Razorpay webhook, everything before Postgres
 * (issue 27-razorpay-webhook-ledger, reordered by 34-webhook-grant-first).
 *
 * This is the only route in the app that ANYBODY on the internet may call. It
 * takes no cookie and no bearer token, so the signature is the whole of the
 * authentication, and A2 says it is checked FIRST:
 *
 *   1. no secret            -> 503, and nothing is read.
 *   2. wrong signature      -> 400, and NOTHING is written. Not even the
 *                              de-dupe row: an unsigned body must not be able
 *                              to put an event id in our table and make the
 *                              real delivery a "duplicate" that does nothing.
 *   3. unreadable body      -> 400.
 *   4. captured / refunded / a subscription status move
 *                           -> the IDEMPOTENT SQL call FIRST, then the event
 *                              id for audit.
 *   5. `subscription.charged`
 *                           -> ONE SQL call that writes its own de-dupe row
 *                              and the month in one transaction.
 *   6. an event that can never succeed
 *                           -> stored, alerted, 200. Never a 500.
 *   7. anything else        -> stored, 200, no money moved.
 *
 * WHY THE ACTION RUNS BEFORE THE DE-DUPE ROW (issue 34). Issue 27 did it the
 * other way: `record_payment_event()` first, the action second, in two round
 * trips. Kill the process between the two (a Vercel timeout is enough) and the
 * event id is committed while the set is still shut. Razorpay's retry is then
 * a "duplicate", this file answers 200, and a student who paid Rs 399 never
 * gets in. `forget_payment_event()` was the answer and it only runs if the
 * process is still alive to run it.
 *
 * Three of the four actions are already idempotent through their own status
 * checks (`grant_purchase` refuses anything not `created`, `refund_purchase`
 * refuses anything already `refunded`, `mark_subscription` just sets a
 * status), so running them FIRST with no de-dupe gate in front of them is
 * safe: a retry gets FALSE and the audit row is written on the way out.
 *
 * `subscription.charged` was the exception, because it added a month per call
 * and month two is a legitimate second call. It now carries its de-dupe key
 * into one SQL call, and the key is built from the SIGNED body
 * (`charged:<payment id>`), NOT from the `x-razorpay-event-id` header: the
 * header is outside the HMAC, so a replay of a genuine body can invent a new
 * header value, and under the old code that bought another month.
 *
 * PLANS SHARE THIS DOOR (issue 28-plan-subscriptions). The four
 * `subscription.*` events arrive on the same URL with the same signature and
 * the same de-dupe, and the issue asks for exactly that. What they do NOT
 * share is the ledger: V19 puts the teacher share on mock sets only, so plan
 * money never reaches `grant_purchase()`, and nothing in this file can make
 * it: a subscription event's action is never `grant`.
 *
 * WHY THE SIGNATURE CANNOT BE CHECKED IN POSTGRES. HMAC-SHA256 runs over the
 * RAW BYTES of the body. Parsing the JSON and sending it on changes those
 * bytes (key order, spacing, number formatting), so by the time a payload
 * reaches `record_payment_event()` the signature can no longer be checked
 * against it. The raw string never leaves this file's caller.
 *
 * WHY THE REPLY IS 2xx SO OFTEN. design.md C: "Webhook replies 2xx fast."
 * Razorpay retries anything that is not 2xx, for hours. An order that is not
 * ours, a payment with no order, a `payment.failed`, a second delivery: all
 * of those are NORMAL and answering 500 would buy us a retry storm and no fix.
 * 500 is kept for the one case a retry really does help: our database refused
 * the write. An event that can NEVER succeed (an order id longer than our
 * column, a fee that is not a fee) is told apart from that by
 * `WebhookPermanentError`, and gets an alert and a 200 instead of hours of
 * retries that cannot help (issue 34).
 *
 * Security. The secret is compared with `timingSafeEqual`, it is read lazily
 * from the environment inside a function (web/CLAUDE.md), it has no
 * `NEXT_PUBLIC_` prefix so Next.js cannot inline it into a bundle, and NOTHING
 * in this file logs. A webhook body carries a payment id and an email, and the
 * signature header is a secret-derived value.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Our own path, so the route file and any docs agree. */
export const RAZORPAY_WEBHOOK_PATH = '/api/webhooks/razorpay';

/** The HMAC-SHA256 of the raw body, hex, as Razorpay sends it. */
export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';

/** Razorpay's own id for this delivery. The de-dupe key when it is sent. */
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

/** Razorpay works in paise; our prices and our ledger are rupees. */
const PAISE_PER_RUPEE = 100;

/** Same ceiling as `payment_events_id_check` in 0027. */
const MAX_EVENT_ID = 120;

/**
 * "The money arrived." Both are sent for one successful order, and handling
 * both is safe: `grant_purchase()` answers false the second time.
 */
const GRANT_EVENTS = new Set(['payment.captured', 'order.paid']);

/**
 * "The money went back." `refund.created` is the instruction and
 * `refund.processed` is the confirmation; the set shuts on either, because a
 * student whose refund is in flight should not be sitting the test.
 */
const REFUND_EVENTS = new Set(['refund.created', 'refund.processed']);

/**
 * "One month of a plan was paid for" (issue 28). Razorpay sends this every
 * cycle, so it is the only subscription event that moves money.
 */
const SUBSCRIPTION_CHARGE_EVENTS = new Set(['subscription.charged']);

/**
 * The three subscription events that move the ROW and not the money.
 *
 * `activated` deliberately grants nothing: Razorpay sends it before the first
 * collection, and a free month for a subscription whose card then fails is a
 * month we cannot get back. `cancelled` and `halted` leave `valid_until`
 * alone, so a student keeps the month they paid for (0028's header).
 */
const SUBSCRIPTION_STATUS_EVENTS: Record<string, SubscriptionStatus> = {
  'subscription.activated': 'active',
  'subscription.cancelled': 'cancelled',
  'subscription.halted': 'halted',
};

/** The three `subscriptions.status` values a webhook may ask for (0028). */
export type SubscriptionStatus = 'active' | 'cancelled' | 'halted';

/** What we do about an event. `none` is stored and otherwise ignored. */
export type WebhookAction =
  | 'grant'
  | 'refund'
  | 'charge_subscription'
  | 'mark_subscription'
  | 'none';

export interface WebhookEvent {
  /** The de-dupe key. Razorpay's own id, or one built from the body. */
  eventId: string;
  /** Razorpay's own word, e.g. `payment.captured`. */
  type: string;
  action: WebhookAction;
  /**
   * Our link back to a `purchases` row. Null when there is no order.
   *
   * ALWAYS null on a subscription event, even though Razorpay puts an
   * `order_id` on a subscription charge: that order is Razorpay's own, not one
   * of ours, and `grant_purchase()` must never be aimed at it.
   */
  orderId: string | null;
  /** Our link back to a `subscriptions` row (issue 28). Razorpay's own id. */
  subscriptionId: string | null;
  /** Where `mark_subscription()` should move the row. Null for everything else. */
  subscriptionStatus: SubscriptionStatus | null;
  /** What Razorpay kept, in rupees to the paisa. 0 when it did not say. */
  feeInr: number;
  /**
   * THE DE-DUPE KEY FOR `subscription.charged`, and only for it (issue 34).
   *
   * `charged:<payment id>`, read out of the SIGNED body. The header event id
   * is NOT used: it is outside the HMAC, so anybody who can replay a genuine
   * signed body can also invent a new header value, and `charge_subscription`
   * adds a month per new key. The payment id is inside the signed bytes and is
   * new every cycle, which is exactly the shape a de-dupe key needs.
   *
   * Null when the body carries no payment id, or one so long the key would not
   * fit `payment_events.event_id`. Both mean "cannot be de-duped safely", and
   * the handler then alerts rather than guessing.
   */
  chargeKey: string | null;
  /**
   * RAZORPAY's own plan id off a subscription event, e.g. `plan_xxx` (issue
   * 34). The store maps it to one of OUR plan words so Postgres can refuse a
   * Rs 100 AI charge that is pointed at a Rs 500 Pro row.
   */
  planId: string | null;
  /**
   * What was ACTUALLY paid, in paise, as the signed body states it (issue 34).
   *
   * Null on a subscription event and whenever the gateway did not say. F-G2
   * made the price come from our database; this is the other half, which is
   * checking that what arrived is what we asked for.
   */
  amountPaise: number | null;
  /** The currency the body states, upper case. Anything but `INR` is refused. */
  currency: string | null;
  /** The parsed body, stored whole for support and the reconcile (A6). */
  payload: unknown;
}

// --------------------------------------------------------------------------
// The two kinds of failure (issue 34-webhook-grant-first)
// --------------------------------------------------------------------------

/**
 * An event that can NEVER succeed, however many times Razorpay delivers it.
 *
 * An order id of 81 characters cannot fit `purchases.razorpay_order_id`, and a
 * "fee" of Rs 400,000 is not a fee. Under issue 27 both threw the same plain
 * `Error` a deadlock throws, so the route answered 500 and Razorpay retried
 * for hours against a wall.
 *
 * A separate class is what lets the handler answer 200, file a
 * `reconcile_alerts` row and put the thing in front of a human instead.
 */
export class WebhookPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookPermanentError';
  }
}

/** True for the one error class that must NOT buy a retry. */
export function isPermanentWebhookError(error: unknown): error is WebhookPermanentError {
  return error instanceof WebhookPermanentError;
}

/**
 * The kinds of `reconcile_alerts` row the WEBHOOK can write (issue 34). The
 * nightly job's own four live in `src/lib/ledger/types.ts`; all seven share
 * one table and one `(kind, subject)` UNIQUE, so Boss has one list.
 */
export type WebhookAlertKind =
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'plan_mismatch'
  | 'bad_event';

export interface WebhookAlertInput {
  kind: WebhookAlertKind;
  /** What names the problem so a human can look it up. 160 characters. */
  subject: string;
  orderId: string | null;
  /** What OUR row says, in paise. */
  expectedPaise: number | null;
  /** What the GATEWAY says, in paise. */
  actualPaise: number | null;
}

// --------------------------------------------------------------------------
// The secret
// --------------------------------------------------------------------------

/**
 * The webhook secret, or null.
 *
 * Read inside a function so `npm run build` and `npm test` both work with no
 * environment variables set (web/CLAUDE.md). It is a DIFFERENT secret from
 * `RAZORPAY_KEY_SECRET` (issue 26): Razorpay generates it when the webhook is
 * registered, and only this file ever needs it.
 */
export function readWebhookSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const secret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

// --------------------------------------------------------------------------
// The signature
// --------------------------------------------------------------------------

/** HMAC-SHA256 of the raw body, hex. Razorpay's own recipe. */
export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * True when `signature` really is this body signed with this secret.
 *
 * `timingSafeEqual` and not `===`, because `===` on strings returns as soon as
 * two characters differ, and that timing difference is enough to guess a
 * signature one character at a time. It throws on buffers of different
 * lengths, so the length is checked first and a wrong length is simply false.
 *
 * Hex is compared lower case: the digest is what we made, and the header is
 * what somebody sent, so the only safe assumption is that their case may vary.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (typeof signature !== 'string') return false;

  const sent = signature.trim().toLowerCase();
  const expected = signWebhookBody(rawBody, secret);
  if (sent.length !== expected.length) return false;

  // A header that is not hex can never match a hex digest, and `Buffer.from`
  // would quietly shorten it, which would then throw in `timingSafeEqual`.
  if (!/^[0-9a-f]+$/.test(sent)) return false;

  return timingSafeEqual(Buffer.from(sent, 'hex'), Buffer.from(expected, 'hex'));
}

// --------------------------------------------------------------------------
// Reading the body
// --------------------------------------------------------------------------

function readText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** One step down an object path, with no faith in any of it. */
function child(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** `payload.<name>.entity`, the shape every Razorpay webhook body uses. */
function entity(body: unknown, name: string): unknown {
  return child(child(child(body, 'payload'), name), 'entity');
}

/** Paise to rupees, to the paisa. Anything unreadable is 0, never a guess. */
function feeRupees(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value) / PAISE_PER_RUPEE;
}

/**
 * A paise amount as the gateway states it: a whole, non-negative number.
 *
 * NULL and not 0 for anything unreadable. 0 is a real amount Razorpay can
 * send, and the amount check treats NULL as "nothing to compare" and 0 as "a
 * payment of nothing", which are different answers.
 */
function paiseOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** A currency code, upper case. Null when the body did not say. */
function currencyOf(value: unknown): string | null {
  const code = readText(value, 8);
  return code ? code.toUpperCase() : null;
}

/**
 * Turn a signed body into the few facts we act on, or null when it cannot be
 * read at all.
 *
 * The event id is Razorpay's own header when it sent one. When it did not, it
 * is `<event type>:<payment id>`, which is DETERMINISTIC: the same delivery
 * twice produces the same id, so the de-dupe still works. A body with neither
 * is refused, because an event we cannot name cannot be de-duped, and an
 * event that cannot be de-duped could pay a teacher twice.
 *
 * THE FALLBACK PREFERS THE PAYMENT ID, and on a subscription that is not a
 * detail. `subscription.charged` carries a NEW payment id every cycle and the
 * SAME subscription id forever, so keying month two on the subscription id
 * would make it a "duplicate" of month one and throw a month the student paid
 * for straight in the bin. The subscription id is the fallback's fallback,
 * used by `activated`, `cancelled` and `halted`, which happen once each.
 */
export function readWebhookEvent(
  rawBody: string,
  headerEventId: string | null | undefined,
): WebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const type = readText(child(body, 'event'), 80) ?? 'unknown';

  const payment = entity(body, 'payment');
  const refund = entity(body, 'refund');
  const order = entity(body, 'order');
  const subscriptionEntity = entity(body, 'subscription');
  const subscriptionId = readText(child(subscriptionEntity, 'id'));

  const paymentId = readText(child(payment, 'id')) ?? readText(child(refund, 'payment_id'));
  const fallbackId = paymentId ?? subscriptionId;

  const eventId =
    readText(headerEventId, MAX_EVENT_ID) ??
    (fallbackId ? (type + ':' + fallbackId).slice(0, MAX_EVENT_ID) : null);
  if (!eventId) return null;

  const subscriptionStatus = SUBSCRIPTION_STATUS_EVENTS[type] ?? null;

  // The order matters. A subscription event is read as a subscription event
  // FIRST, so a `subscription.charged` body can never fall through to the
  // mock-set grant and ask `grant_purchase()` about Razorpay's own order id.
  const subscription =
    SUBSCRIPTION_CHARGE_EVENTS.has(type) && subscriptionId
      ? 'charge_subscription'
      : subscriptionStatus && subscriptionId
        ? 'mark_subscription'
        : null;

  const action: WebhookAction =
    subscription ??
    (GRANT_EVENTS.has(type) ? 'grant' : REFUND_EVENTS.has(type) ? 'refund' : 'none');

  // THE CHARGE KEY (issue 34). Built from the payment id in the SIGNED body,
  // never from `headerEventId`. It is refused rather than truncated when it
  // would not fit `payment_events.event_id`: two different payment ids sharing
  // a 120-character prefix would then be one key, and one of the two months
  // would vanish.
  const charged = subscription === 'charge_subscription' && paymentId ? 'charged:' + paymentId : null;
  const chargeKey = charged && charged.length <= MAX_EVENT_ID ? charged : null;

  return {
    eventId,
    type,
    action,
    // The payment entity carries our order id on both the capture and the
    // refund. `payload.order.entity.id` is the `order.paid` shape. A
    // subscription event gets null: see the note on the field.
    orderId: subscription
      ? null
      : (readText(child(payment, 'order_id')) ?? readText(child(order, 'id'))),
    subscriptionId,
    subscriptionStatus: subscription === 'mark_subscription' ? subscriptionStatus : null,
    feeInr: feeRupees(child(payment, 'fee')),
    chargeKey,
    planId: readText(child(subscriptionEntity, 'plan_id'), 80),
    // Null on a subscription event: that amount is Razorpay's own charge
    // against its own plan object, and there is no `purchases` row to check it
    // against. `order.paid` is the one shape where the amount sits on the
    // order rather than on the payment.
    amountPaise: subscription
      ? null
      : (paiseOf(child(payment, 'amount')) ?? paiseOf(child(order, 'amount'))),
    currency: subscription
      ? null
      : (currencyOf(child(payment, 'currency')) ?? currencyOf(child(order, 'currency'))),
    payload: body,
  };
}

// --------------------------------------------------------------------------
// The store, behind one interface
// --------------------------------------------------------------------------

export interface RecordEventInput {
  eventId: string;
  type: string;
  payload: unknown;
}

/**
 * The SQL functions in `0027_ledger.sql` and `0028_subscriptions.sql`, and
 * nothing else. Faked in every test, so no test touches a network or a key
 * (web/CLAUDE.md).
 */
export interface WebhookStore {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** `record_payment_event()`. TRUE = new, FALSE = seen it, do nothing. */
  recordEvent(input: RecordEventInput): Promise<boolean>;
  /**
   * `forget_payment_event()`. The compensating step: see the note on the 500
   * path in `handleRazorpayWebhook()`.
   */
  forgetEvent(eventId: string): Promise<void>;
  /**
   * `grant_purchase()`. One transaction: paid, access, ledger row.
   *
   * IDEMPOTENT, which is why issue 34 calls it before `recordEvent`. The two
   * optional fields are the signed body's own amount and currency; Postgres
   * refuses the grant and files an alert when they disagree with our
   * `purchases` row. Leaving them out means "the gateway did not say", which
   * is not a refusal.
   */
  grantPurchase(input: {
    orderId: string;
    feeInr: number;
    amountPaise?: number | null;
    currency?: string | null;
  }): Promise<void>;
  /** `refund_purchase()`. created or paid -> refunded, and the set shuts. */
  refundPurchase(input: { orderId: string }): Promise<void>;
  /**
   * `charge_subscription()` (issue 28, one transaction since issue 34). One
   * more paid month on `entitlements.valid_until`, stacked on what is already
   * paid for. Writes NO ledger row: V19 puts the teacher share on mock sets
   * only.
   *
   * `chargeKey` is the de-dupe key from the SIGNED body, and Postgres inserts
   * it in the SAME transaction as the month, so there is no gap for a crash.
   * `type` and `payload` are what that row stores. `planId` is Razorpay's own
   * plan id, which the store maps to one of our plan words.
   */
  chargeSubscription(input: {
    subscriptionId: string;
    chargeKey?: string | null;
    type?: string;
    payload?: unknown;
    planId?: string | null;
  }): Promise<void>;
  /**
   * `mark_subscription()` (issue 28). activated / cancelled / halted. Touches
   * no entitlement, so a cancelled plan keeps the month it paid for.
   */
  markSubscription(input: {
    subscriptionId: string;
    status: SubscriptionStatus;
  }): Promise<void>;
  /**
   * `record_reconcile_alert()` (issue 34). The webhook's own half of A6: a
   * body that can never be handled is put on Boss's list instead of being
   * retried for hours. The nightly job writes to the same table.
   */
  recordAlert(input: WebhookAlertInput): Promise<void>;
}

// --------------------------------------------------------------------------
// The handler
// --------------------------------------------------------------------------

export type WebhookErrorCode = 'bad_signature' | 'bad_request' | 'not_configured' | 'store';

export type WebhookReply =
  | { status: 200; body: { ok: true } }
  | { status: number; body: { error: WebhookErrorCode } };

export interface WebhookInput {
  /** The body EXACTLY as it arrived. Never a re-serialised object. */
  rawBody: string;
  signature: string | null;
  eventIdHeader?: string | null;
  /** From `readWebhookSecret()`. Null means we cannot check anything. */
  secret: string | null;
  store: WebhookStore;
}

const OK: WebhookReply = { status: 200, body: { ok: true } };

function fail(status: number, error: WebhookErrorCode): WebhookReply {
  return { status, body: { error } };
}

/**
 * The three IDEMPOTENT actions. Each one re-reads its row under a lock in
 * Postgres and refuses a state it has already left, so calling it twice is the
 * same as calling it once. That is what makes it safe to run BEFORE the audit
 * row (issue 34).
 *
 * `none`, a capture with no order of ours, and a subscription event with no id
 * all fall through and do nothing, which is normal and is answered 200.
 */
async function runIdempotentAction(store: WebhookStore, event: WebhookEvent): Promise<void> {
  if (event.action === 'grant' && event.orderId) {
    await store.grantPurchase({
      orderId: event.orderId,
      feeInr: event.feeInr,
      amountPaise: event.amountPaise,
      currency: event.currency,
    });
    return;
  }

  if (event.action === 'refund' && event.orderId) {
    await store.refundPurchase({ orderId: event.orderId });
    return;
  }

  if (event.action === 'mark_subscription' && event.subscriptionId && event.subscriptionStatus) {
    await store.markSubscription({
      subscriptionId: event.subscriptionId,
      status: event.subscriptionStatus,
    });
  }
}

/**
 * The audit row, written AFTER the work (issue 34).
 *
 * A failure here is a 500, and that 500 is safe: the action it follows is
 * idempotent, so Razorpay's retry re-runs it, gets FALSE, and writes the row.
 * There is no `forgetEvent` to make, because nothing was written first.
 */
async function rememberEvent(store: WebhookStore, event: WebhookEvent): Promise<WebhookReply> {
  try {
    await store.recordEvent({
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
    });
  } catch {
    return fail(500, 'store');
  }
  return OK;
}

/**
 * An event that can never succeed: tell Boss, keep the body, answer 200.
 *
 * BOTH WRITES ARE SWALLOWED on purpose. We are already certain a retry cannot
 * help, so a failed alert or a failed audit row must not turn into the retry
 * storm this whole path exists to avoid. The nightly reconcile (A6) is the
 * backstop that finds a captured payment with no `paid` purchase behind it.
 */
async function giveUpOn(
  store: WebhookStore,
  event: WebhookEvent,
  subject: string,
): Promise<WebhookReply> {
  try {
    await store.recordAlert({
      kind: 'bad_event',
      subject,
      orderId: null,
      expectedPaise: null,
      actualPaise: null,
    });
  } catch {
    // Deliberately empty. See above.
  }

  try {
    await store.recordEvent({
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
    });
  } catch {
    // Deliberately empty. See above.
  }

  return OK;
}

export async function handleRazorpayWebhook({
  rawBody,
  signature,
  eventIdHeader,
  secret,
  store,
}: WebhookInput): Promise<WebhookReply> {
  // 1. No secret, no trust. Answered before the body is even parsed, and
  //    503 rather than 400 because the fault is ours, not the sender's.
  if (!secret) return fail(503, 'not_configured');

  // 2. A2: the signature, FIRST, before a single write.
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return fail(400, 'bad_signature');
  }

  const event = readWebhookEvent(rawBody, eventIdHeader);
  if (!event) return fail(400, 'bad_request');

  if (!store.isConfigured()) return fail(503, 'not_configured');

  // 3. `subscription.charged` is its OWN path, because it is the one action
  //    that is not idempotent: month two is a legitimate second call, so no
  //    status check can tell a retry from a renewal. It carries its de-dupe
  //    key into ONE SQL call, which writes the key and the month in one
  //    transaction. There is no second `recordEvent` here: that key IS the
  //    audit row, and a second row keyed on the header would be the same
  //    delivery filed twice.
  if (event.action === 'charge_subscription' && event.subscriptionId) {
    if (!event.chargeKey) {
      // Nothing safe is left to do. Keying the month on the SUBSCRIPTION id
      // would make month two a duplicate of month one and bin a month the
      // student paid for, so the month is not bought and Boss is told.
      return giveUpOn(store, event, 'charged:no-payment-id:' + event.eventId);
    }

    try {
      // One month, and NO ledger row: the fee is not read here on purpose,
      // because plan money has no teacher share to take it out of (V19).
      await store.chargeSubscription({
        subscriptionId: event.subscriptionId,
        chargeKey: event.chargeKey,
        type: event.type,
        payload: event.payload,
        planId: event.planId,
      });
    } catch (error) {
      if (!isPermanentWebhookError(error)) return fail(500, 'store');
      return giveUpOn(store, event, 'event:' + event.eventId);
    }

    return OK;
  }

  // 4. THE MONEY, FIRST, with no de-dupe gate in front of it. See the header:
  //    the three actions reachable from here all refuse a state they have
  //    already left, so a retry is a no-op and a crash before step 5 cannot
  //    lock a paying student out.
  try {
    await runIdempotentAction(store, event);
  } catch (error) {
    // A database that is merely unwell gets its retry, and nothing was
    // written before the action, so that retry is clean.
    if (!isPermanentWebhookError(error)) return fail(500, 'store');
    return giveUpOn(store, event, 'event:' + event.eventId);
  }

  // 5. The audit row, last.
  return rememberEvent(store, event);
}

// --------------------------------------------------------------------------
// The fake
// --------------------------------------------------------------------------

export interface FakeWebhookStoreOptions {
  configured?: boolean;
  /** Throw from every action, for the 500 path. */
  failAction?: boolean;
  /** Throw from `recordEvent`, for the "the audit row did not land" path. */
  failRecord?: boolean;
  /**
   * Throw a `WebhookPermanentError` from every action (issue 34), for the
   * "this can never succeed" path that must be answered 200.
   */
  failPermanently?: boolean;
  /** Throw from `recordAlert`, to prove a failed alert is still a 200. */
  failAlert?: boolean;
}

export interface FakeWebhookStore {
  store: WebhookStore;
  /** Events currently stored, newest last. A forgotten event is gone. */
  readonly events: { eventId: string; type: string }[];
  /** The whole bodies, in the same order as `events`. */
  readonly payloads: unknown[];
  /** Event ids that were stored and then released by the 500 path. */
  readonly forgotten: string[];
  readonly granted: { orderId: string; feeInr: number }[];
  readonly refunded: { orderId: string }[];
  /** Plan months bought, in order (issue 28). */
  readonly charged: { subscriptionId: string }[];
  /** The de-dupe key each month was bought with, in order (issue 34). */
  readonly chargeKeys: (string | null)[];
  /** The Razorpay plan id each charge carried, in order (issue 34). */
  readonly chargedPlans: (string | null)[];
  /** Subscription status moves, in order (issue 28). */
  readonly marked: { subscriptionId: string; status: SubscriptionStatus }[];
  /** `reconcile_alerts` rows the webhook filed, in order (issue 34). */
  readonly alerts: WebhookAlertInput[];
  /**
   * Every store method the handler called, in order (issue 34). This is how
   * the tests prove the ACTION runs before the audit row, which is the whole
   * ticket. `isConfigured` is not logged: it is a question, not a write.
   */
  readonly calls: string[];
  /** Turn the action failure on or off, so a retry can be tested. */
  failAction(value: boolean): void;
  /** Turn the audit-row failure on or off, for the crash-then-retry test. */
  failRecord(value: boolean): void;
}

/**
 * The one fake store in the suite. No network, no key, no Supabase.
 *
 * IT MODELS THE REAL IDEMPOTENCY, and since issue 34 it has to. The handler no
 * longer puts a de-dupe gate in front of the action, so the fake is what
 * stands in for `grant_purchase()`'s "must be `created`" check,
 * `refund_purchase()`'s "not already refunded", and the `payment_events`
 * primary key inside `charge_subscription()`. A fake that happily granted
 * twice would make a passing test prove nothing.
 */
export function createFakeWebhookStore(
  options: FakeWebhookStoreOptions = {},
): FakeWebhookStore {
  const rows: { eventId: string; type: string; payload: unknown }[] = [];
  const forgotten: string[] = [];
  const granted: { orderId: string; feeInr: number }[] = [];
  const refunded: { orderId: string }[] = [];
  const charged: { subscriptionId: string }[] = [];
  const chargeKeys: (string | null)[] = [];
  const chargedPlans: (string | null)[] = [];
  const marked: { subscriptionId: string; status: SubscriptionStatus }[] = [];
  const alerts: WebhookAlertInput[] = [];
  const calls: string[] = [];
  /** `purchases.status`, the only part of 0026 the fake has to remember. */
  const purchases = new Map<string, 'paid' | 'refunded'>();
  const configured = options.configured ?? true;
  let failing = options.failAction ?? false;
  let failingRecord = options.failRecord ?? false;

  /** The action failure, in whichever of the two flavours is switched on. */
  function refuse(what: string): never {
    if (options.failPermanently) {
      throw new WebhookPermanentError('the webhook cannot ' + what);
    }
    throw new Error(what + ' failed');
  }

  function stop(what: string) {
    if (failing || options.failPermanently) refuse(what);
  }

  const store: WebhookStore = {
    isConfigured() {
      return configured;
    },
    async recordEvent({ eventId, type, payload }) {
      calls.push('recordEvent');
      if (failingRecord) throw new Error('record failed');
      // Same answer as the primary key in 0027: the second one loses.
      if (rows.some((row) => row.eventId === eventId)) return false;
      rows.push({ eventId, type, payload });
      return true;
    },
    async forgetEvent(eventId: string) {
      calls.push('forgetEvent');
      const at = rows.findIndex((row) => row.eventId === eventId);
      if (at >= 0) rows.splice(at, 1);
      forgotten.push(eventId);
    },
    async grantPurchase({ orderId, feeInr }) {
      calls.push('grantPurchase');
      stop('grant');
      // A3, as 0027 enforces it: only a `created` row moves to `paid`, so a
      // second delivery and a late capture after a refund both do nothing.
      if (purchases.has(orderId)) return;
      purchases.set(orderId, 'paid');
      granted.push({ orderId, feeInr });
    },
    async refundPurchase({ orderId }) {
      calls.push('refundPurchase');
      stop('refund');
      // A3 again: `created` and `paid` both move to `refunded`, and
      // `refunded` is where it stops (issue 34).
      if (purchases.get(orderId) === 'refunded') return;
      purchases.set(orderId, 'refunded');
      refunded.push({ orderId });
    },
    async chargeSubscription({ subscriptionId, chargeKey, type, payload, planId }) {
      calls.push('chargeSubscription');
      stop('charge');
      // The de-dupe row and the month, in one step, the way 0034 does it.
      if (chargeKey) {
        if (rows.some((row) => row.eventId === chargeKey)) return;
        rows.push({ eventId: chargeKey, type: type ?? 'subscription.charged', payload });
      }
      charged.push({ subscriptionId });
      chargeKeys.push(chargeKey ?? null);
      chargedPlans.push(planId ?? null);
    },
    async markSubscription(input) {
      calls.push('markSubscription');
      stop('mark');
      marked.push(input);
    },
    async recordAlert(input) {
      calls.push('recordAlert');
      if (options.failAlert) throw new Error('alert failed');
      // `(kind, subject)` is UNIQUE in 0029: the same problem twice is one row.
      const already = alerts.some((one) => one.kind === input.kind && one.subject === input.subject);
      if (!already) alerts.push(input);
    },
  };

  return {
    store,
    get events() {
      return rows.map(({ eventId, type }) => ({ eventId, type }));
    },
    get payloads() {
      return rows.map((row) => row.payload);
    },
    forgotten,
    granted,
    refunded,
    charged,
    chargeKeys,
    chargedPlans,
    marked,
    alerts,
    calls,
    failAction(value: boolean) {
      failing = value;
    },
    failRecord(value: boolean) {
      failingRecord = value;
    },
  };
}
