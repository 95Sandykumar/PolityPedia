/**
 * The checkout contract (issue 26-razorpay-order-checkout).
 *
 * Razorpay is an outside service, so it sits behind ONE interface here and is
 * faked in every test: no real network call and no real key anywhere in the
 * suite (web/CLAUDE.md). `createFakePayments()` is that fake, and it lives
 * here rather than in a test file because issue 27 (webhook and ledger) needs
 * the same one.
 *
 *  * `Payments`        -- the gateway. Create an order, read its payments.
 *  * `CheckoutClient`  -- our own database, through the two SECURITY DEFINER
 *                         functions in `0026_purchases.sql`. Carries the
 *                         student's own access token, so RLS decides.
 *  * `BrowserCheckoutClient` -- the page. Posts to our own route, sees no key.
 *
 * WHAT IS NOT HERE: the amount. F-G2 says "the price always comes from our
 * database, never from the phone", so there is no price in this file, no
 * price in the request body and no price in the browser until the database
 * has answered. `start()` sends a set id and a coupon code, and gets rupees
 * back.
 *
 * Test mode only. Live keys are ticket H5.
 */

/** Our own route the Unlock button posts to. Holds no key. */
export const CHECKOUT_ORDER_PATH = '/api/checkout/order';

/** Our own route the Subscribe button posts to (issue 28). Holds no key. */
export const CHECKOUT_SUBSCRIPTION_PATH = '/api/checkout/subscription';

/**
 * Razorpay's own checkout script. Loaded ONLY when Unlock is tapped
 * (DESIGN.md section 10: the student page budget is 150 KB gzipped, and a
 * student who never buys must not pay for a gateway bundle on every page).
 */
export const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** What the student is buying, as the gateway names it on the card screen. */
export const CHECKOUT_BRAND = 'PolityPedia';

/** Razorpay works in paise, our prices and our ledger are whole rupees. */
export const PAISE_PER_RUPEE = 100;

/** Same shape as `coupons_code_check` in 0026. */
const COUPON_MIN = 3;
export const MAX_COUPON_LENGTH = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared by the route handler, the Supabase client and the page. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * A coupon as the database stores it: trimmed and upper case, so `free100`
 * and `FREE100` are one code. Anything unusable is null, which means "no
 * coupon" and never "a coupon that failed": an empty box is not a mistake.
 */
export function normaliseCoupon(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length < COUPON_MIN || code.length > MAX_COUPON_LENGTH) return null;
  return code;
}

/**
 * V18's two paid plans. Re-declared here rather than imported from
 * `@/lib/plans/types` ON PURPOSE: this file is the payments contract and is
 * imported by the browser bundle, and a one-way dependency is cheaper than a
 * cycle between two contract files. `plans/types.ts` keeps the same two names
 * and `src/lib/plans/__tests__/subscribe-route.test.ts` proves they agree.
 */
export type Plan = 'ai' | 'pro';
export const PLANS: readonly Plan[] = ['ai', 'pro'];

export function isPaidPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

/** `purchases.status`. Same list as `purchases_status_check`. */
export type PurchaseStatus = 'created' | 'paid' | 'refunded';

/** What `start_set_purchase()` hands back. */
export interface StartedPurchase {
  purchaseId: string;
  /** Rupees owed after the coupon, decided by Postgres. */
  amountInr: number;
  /** `paid` is the A4 zero-price path: already done, no gateway needed. */
  status: PurchaseStatus;
}

/**
 * Why a purchase could not start. Every one of these is a sentence the UI can
 * say; `failed` is the catch-all, because a Postgres message may quote a
 * policy or constraint name and must never reach a browser.
 */
export type PurchaseFailure =
  | 'sign_in'
  | 'not_found'
  | 'owned'
  | 'own_set'
  | 'coupon'
  | 'failed';

/**
 * The SQLSTATEs `0026_purchases.sql` raises, mapped to the codes above.
 *
 * Custom five-character codes on purpose: `check_violation` would have had to
 * mean both "your own set" and "bad coupon", and the UI needs to tell a
 * student which one it was.
 */
const FAILURE_BY_SQLSTATE: Record<string, PurchaseFailure> = {
  PP401: 'sign_in',
  PP403: 'own_set',
  PP404: 'not_found',
  PP409: 'owned',
  PP422: 'coupon',
};

/** A refusal with a code the UI can switch on. Carries no Postgres text. */
export class PurchaseError extends Error {
  readonly code: PurchaseFailure;

  constructor(code: PurchaseFailure) {
    super('purchase refused: ' + code);
    this.name = 'PurchaseError';
    this.code = code;
  }
}

/** Turn a PostgREST error payload into one of our codes. Never throws. */
export function purchaseFailureFrom(sqlstate: unknown): PurchaseFailure {
  if (typeof sqlstate !== 'string') return 'failed';
  return FAILURE_BY_SQLSTATE[sqlstate.trim().toUpperCase()] ?? 'failed';
}

/** Rupees to paise, for the gateway only. */
export function toPaise(amountInr: number): number {
  if (!Number.isFinite(amountInr) || amountInr < 0) {
    throw new Error('amount must be a non-negative number of rupees');
  }
  return Math.round(amountInr) * PAISE_PER_RUPEE;
}

// --------------------------------------------------------------------------
// The gateway, behind one interface
// --------------------------------------------------------------------------

export interface CreateOrderInput {
  /** Rupees, straight from `start_set_purchase()`. Never from a request. */
  amountInr: number;
  /** Our own purchase id, so Razorpay's receipt points back at our row. */
  receipt: string;
  /** Short strings only. Razorpay shows them on the payment in its console. */
  notes?: Record<string, string>;
}

export interface PaymentsOrder {
  orderId: string;
  amountPaise: number;
  currency: string;
}

// --------------------------------------------------------------------------
// Subscriptions (issue 28-plan-subscriptions)
// --------------------------------------------------------------------------

/**
 * What `createSubscription()` needs, and it is NOT a price.
 *
 * Razorpay bills a subscription against a PLAN OBJECT that lives in its own
 * console, and the amount is attached to that plan there. So the only thing
 * that travels is which of V18's two plans this is; the adapter maps it to the
 * Razorpay plan id out of the environment, and the rupees in our own
 * `subscriptions` row come from `plan_price_inr()` in Postgres. F-G2 holds
 * without a single amount in this file.
 */
export interface CreateSubscriptionInput {
  plan: Plan;
  /** Short strings only. Razorpay shows them on the subscription. */
  notes?: Record<string, string>;
}

/** What Razorpay hands back when a subscription is opened. */
export interface PaymentsSubscription {
  /** Razorpay's own id, e.g. `sub_xxx`. Our webhook's only key. */
  subscriptionId: string;
  /** Razorpay's own word: `created`, `authenticated`, `active`. */
  status: string;
}

/** One payment against an order, for the nightly reconcile (A6, issue 27). */
export interface PaymentRecord {
  paymentId: string;
  orderId: string | null;
  amountPaise: number;
  /** Razorpay's own word: `captured`, `authorized`, `failed` and so on. */
  status: string;
}

/** Razorpay, behind six methods. Faked in every test. */
export interface Payments {
  /** False when the Razorpay env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** The PUBLIC key id the browser needs to open checkout. Never the secret. */
  keyId(): string | null;
  createOrder(input: CreateOrderInput): Promise<PaymentsOrder>;
  /** Reconcile (A6) and issue 27's webhook cross-check. */
  fetchPayments(orderId: string): Promise<PaymentRecord[]>;
  /**
   * False when the Razorpay PLAN ID for this plan is missing (issue 28).
   * Separate from `isConfigured()` because the keys and the plan objects are
   * set up at different times: keys first, then one plan per price. A page
   * that knows the difference can offer AI while Pro is still being created.
   */
  hasPlan(plan: Plan): boolean;
  /** Open one monthly subscription at Razorpay (issue 28). */
  createSubscription(input: CreateSubscriptionInput): Promise<PaymentsSubscription>;
}

// --------------------------------------------------------------------------
// Our own database, behind one interface
// --------------------------------------------------------------------------

export interface StartPurchaseInput {
  setId: string;
  /** Already normalised, or null. There is NO amount: F-G2. */
  coupon?: string | null;
}

/** Server side. Carries the student's own access token, so RLS decides. */
export interface CheckoutClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** `start_set_purchase()`. Throws `PurchaseError` on a refusal. */
  start(input: StartPurchaseInput): Promise<StartedPurchase>;
  /** `attach_order_id()`. Single-shot inside Postgres (A1). */
  attachOrderId(purchaseId: string, orderId: string): Promise<void>;
}

// --------------------------------------------------------------------------
// The browser side
// --------------------------------------------------------------------------

/** What the page needs to open Razorpay checkout. No secret in sight. */
export interface CheckoutOrder {
  purchaseId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  /** The PUBLIC key id. */
  keyId: string;
}

/** Either the set opened for free (A4), or there is an order to pay. */
export type CheckoutStart =
  | { free: true; purchaseId: string }
  | ({ free: false } & CheckoutOrder);

/** Browser side. Calls our own route; never sees a key. */
export interface BrowserCheckoutClient {
  start(input: { setId: string; coupon?: string | null }): Promise<CheckoutStart>;
}

// --------------------------------------------------------------------------
// The fake
// --------------------------------------------------------------------------

export interface FakePaymentsOptions {
  configured?: boolean;
  keyId?: string | null;
  /** Throw instead of answering, so the route's gateway path is testable. */
  failCreate?: boolean;
  payments?: readonly PaymentRecord[];
  /**
   * Which plans have a Razorpay plan id. Default: both (issue 28). Pass `[]`
   * to test the "keys are set up but the plan object is not" state.
   */
  plans?: readonly Plan[];
}

export interface FakePayments {
  payments: Payments;
  /** Every `createOrder` call, in order. Empty proves A4 called no gateway. */
  orders: CreateOrderInput[];
  /** Every `fetchPayments` call, in order. */
  fetched: string[];
  /** Every `createSubscription` call, in order (issue 28). */
  subscriptions: CreateSubscriptionInput[];
}

/**
 * The one fake Razorpay in the suite. Order ids count up, so a test can say
 * `order_test_1` without reaching for a stub library.
 */
export function createFakePayments(options: FakePaymentsOptions = {}): FakePayments {
  const orders: CreateOrderInput[] = [];
  const fetched: string[] = [];
  const subscriptions: CreateSubscriptionInput[] = [];
  const configured = options.configured ?? true;
  const plans = options.plans ?? PLANS;
  const keyId = options.keyId === undefined ? 'rzp_test_fake' : options.keyId;

  const payments: Payments = {
    isConfigured() {
      return configured;
    },
    keyId() {
      return configured ? keyId : null;
    },
    async createOrder(input: CreateOrderInput) {
      orders.push(input);
      if (options.failCreate) throw new Error('Razorpay order failed with status 500');
      return {
        orderId: 'order_test_' + orders.length,
        amountPaise: toPaise(input.amountInr),
        currency: 'INR',
      };
    },
    async fetchPayments(orderId: string) {
      fetched.push(orderId);
      return [...(options.payments ?? [])];
    },
    hasPlan(plan: Plan) {
      return configured && plans.includes(plan);
    },
    async createSubscription(input: CreateSubscriptionInput) {
      subscriptions.push(input);
      if (options.failCreate) throw new Error('Razorpay subscription failed with status 500');
      return {
        subscriptionId: 'sub_test_' + subscriptions.length,
        status: 'created',
      };
    },
  };

  return { payments, orders, fetched, subscriptions };
}
