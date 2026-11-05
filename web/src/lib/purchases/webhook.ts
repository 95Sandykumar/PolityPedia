/**
 * The Razorpay webhook, everything before Postgres
 * (issue 27-razorpay-webhook-ledger).
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
 *   4. event already seen   -> 200, and nothing happens (A1).
 *   5. captured / refunded  -> one SQL call, which is one transaction.
 *   6. anything else        -> stored, 200, no money moved.
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
 * the write.
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

/** What we do about an event. `none` is stored and otherwise ignored. */
export type WebhookAction = 'grant' | 'refund' | 'none';

export interface WebhookEvent {
  /** The de-dupe key. Razorpay's own id, or one built from the body. */
  eventId: string;
  /** Razorpay's own word, e.g. `payment.captured`. */
  type: string;
  action: WebhookAction;
  /** Our link back to a `purchases` row. Null when there is no order. */
  orderId: string | null;
  /** What Razorpay kept, in rupees to the paisa. 0 when it did not say. */
  feeInr: number;
  /** The parsed body, stored whole for support and the reconcile (A6). */
  payload: unknown;
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
 * Turn a signed body into the few facts we act on, or null when it cannot be
 * read at all.
 *
 * The event id is Razorpay's own header when it sent one. When it did not, it
 * is `<event type>:<payment id>`, which is DETERMINISTIC: the same delivery
 * twice produces the same id, so the de-dupe still works. A body with neither
 * is refused, because an event we cannot name cannot be de-duped, and an
 * event that cannot be de-duped could pay a teacher twice.
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

  const paymentId = readText(child(payment, 'id')) ?? readText(child(refund, 'payment_id'));

  const eventId =
    readText(headerEventId, MAX_EVENT_ID) ??
    (paymentId ? (type + ':' + paymentId).slice(0, MAX_EVENT_ID) : null);
  if (!eventId) return null;

  const action: WebhookAction = GRANT_EVENTS.has(type)
    ? 'grant'
    : REFUND_EVENTS.has(type)
      ? 'refund'
      : 'none';

  return {
    eventId,
    type,
    action,
    // The payment entity carries our order id on both the capture and the
    // refund. `payload.order.entity.id` is the `order.paid` shape.
    orderId: readText(child(payment, 'order_id')) ?? readText(child(entity(body, 'order'), 'id')),
    feeInr: feeRupees(child(payment, 'fee')),
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
 * The three SQL functions in `0027_ledger.sql`, and nothing else. Faked in
 * every test, so no test touches a network or a key (web/CLAUDE.md).
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
  /** `grant_purchase()`. One transaction: paid, access, ledger row. */
  grantPurchase(input: { orderId: string; feeInr: number }): Promise<void>;
  /** `refund_purchase()`. paid -> refunded, and the set shuts. */
  refundPurchase(input: { orderId: string }): Promise<void>;
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

  // 3. A2's second half. The insert IS the de-dupe, so two deliveries racing
  //    each other cannot both be told "new".
  let fresh: boolean;
  try {
    fresh = await store.recordEvent({
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
    });
  } catch {
    // Nothing was written, so a retry is clean. 500 asks for that retry.
    return fail(500, 'store');
  }

  // A1. Seen it. Reply 2xx so Razorpay stops, and change nothing.
  if (!fresh) return OK;

  // 4. The money. `none`, and a capture with no order of ours, fall through:
  //    the event is stored and the reply is 200.
  try {
    if (event.action === 'grant' && event.orderId) {
      await store.grantPurchase({ orderId: event.orderId, feeInr: event.feeInr });
    } else if (event.action === 'refund' && event.orderId) {
      await store.refundPurchase({ orderId: event.orderId });
    }
  } catch {
    // THE EVENT ROW HAS TO GO. It was written a moment ago and the work it
    // stands for did not happen, so leaving it would make Razorpay's next
    // delivery a "duplicate" that does nothing, and the student would have
    // paid for a set that never opens.
    //
    // A failed forget is swallowed: we are already answering 500, and the
    // nightly reconcile (A6, design.md P10) is the backstop that finds a
    // captured Razorpay payment with no `paid` purchase behind it.
    try {
      await store.forgetEvent(event.eventId);
    } catch {
      // Deliberately empty. See above.
    }
    return fail(500, 'store');
  }

  return OK;
}

// --------------------------------------------------------------------------
// The fake
// --------------------------------------------------------------------------

export interface FakeWebhookStoreOptions {
  configured?: boolean;
  /** Throw from `grantPurchase` and `refundPurchase`, for the 500 path. */
  failAction?: boolean;
  /** Throw from `recordEvent`, for the "cannot even de-dupe" path. */
  failRecord?: boolean;
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
  /** Turn the action failure on or off, so a retry can be tested. */
  failAction(value: boolean): void;
}

/** The one fake store in the suite. No network, no key, no Supabase. */
export function createFakeWebhookStore(
  options: FakeWebhookStoreOptions = {},
): FakeWebhookStore {
  const rows: { eventId: string; type: string; payload: unknown }[] = [];
  const forgotten: string[] = [];
  const granted: { orderId: string; feeInr: number }[] = [];
  const refunded: { orderId: string }[] = [];
  const configured = options.configured ?? true;
  let failing = options.failAction ?? false;

  const store: WebhookStore = {
    isConfigured() {
      return configured;
    },
    async recordEvent({ eventId, type, payload }) {
      if (options.failRecord) throw new Error('record failed');
      // Same answer as the primary key in 0027: the second one loses.
      if (rows.some((row) => row.eventId === eventId)) return false;
      rows.push({ eventId, type, payload });
      return true;
    },
    async forgetEvent(eventId: string) {
      const at = rows.findIndex((row) => row.eventId === eventId);
      if (at >= 0) rows.splice(at, 1);
      forgotten.push(eventId);
    },
    async grantPurchase(input) {
      if (failing) throw new Error('grant failed');
      granted.push(input);
    },
    async refundPurchase(input) {
      if (failing) throw new Error('refund failed');
      refunded.push(input);
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
    failAction(value: boolean) {
      failing = value;
    },
  };
}
