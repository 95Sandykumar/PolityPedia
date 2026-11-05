/**
 * The real `Payments`: Razorpay Orders over its REST API
 * (issue 26-razorpay-order-checkout).
 *
 * TEST MODE ONLY. The keys come from the environment, and a test-mode key id
 * starts `rzp_test_`. Switching to live keys is ticket H5 and is Boss's
 * decision, not this slice's.
 *
 * Why plain `fetch` and not the `razorpay` npm package: the same two reasons
 * the rest of this app gives (see `anthropic-explainer.ts`). One, nothing of a
 * payment client can leak into a browser bundle. Two, a test injects
 * `fetchImpl` and there is no network stack to mock. If the SDK is added
 * later, only this file changes: `Payments` is the seam.
 *
 * The env is read lazily inside every call, so importing this file can never
 * break a build with no environment variables (web/CLAUDE.md), and
 * `isConfigured()` lets the route answer "not configured" instead of throwing.
 *
 * Security: `RAZORPAY_KEY_SECRET` is a secret.
 *  * It is NOT prefixed `NEXT_PUBLIC_`, so it never reaches a bundle.
 *  * It goes in an Authorization header, never in a URL.
 *  * `keyId()` hands out the PUBLIC half only. Razorpay's own checkout needs
 *    the key id in the browser; the secret stays here.
 *  * No console call lives in this file, and every thrown error carries a
 *    fixed message plus the HTTP status, never a response body.
 */
import {
  toPaise,
  type CreateOrderInput,
  type CreateSubscriptionInput,
  type PaymentRecord,
  type Payments,
  type Plan,
} from './types';

const API = 'https://api.razorpay.com/v1';

/** Razorpay caps `receipt` at 40 characters. A uuid is 36, so it fits. */
const MAX_RECEIPT = 40;

/** One page of payments against one order. A single order has very few. */
const PAYMENTS_PER_PAGE = 20;

/**
 * How many cycles a subscription is opened for (issue 28).
 *
 * Razorpay WANTS a `total_count`; there is no "forever". Ten years of months
 * is the practical reading of "monthly until cancelled": a student who really
 * subscribes for ten years can resubscribe, and a smaller number would quietly
 * end somebody's plan on a date nobody chose.
 */
const SUBSCRIPTION_TOTAL_COUNT = 120;

/**
 * The env var holding the RAZORPAY PLAN ID for each of V18's plans.
 *
 * A Razorpay plan is an object in its console with the amount on it, created
 * once per price. Its id is NOT a secret (it names a public price), but it is
 * environment-specific, so it is read lazily like everything else and is not
 * prefixed `NEXT_PUBLIC_`: nothing in a browser needs it.
 */
const PLAN_ENV_VAR: Record<Plan, string> = {
  ai: 'RAZORPAY_PLAN_AI_ID',
  pro: 'RAZORPAY_PLAN_PRO_ID',
};

/** The Razorpay plan id for one of our plans, or null. */
export function readRazorpayPlanId(
  plan: Plan,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const name = PLAN_ENV_VAR[plan];
  if (!name) return null;
  const id = env[name]?.trim();
  return id && id.length > 0 ? id : null;
}

export interface RazorpayEnv {
  keyId: string;
  keySecret: string;
}

export interface RazorpayPaymentsOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function readRazorpayEnv(
  env: Record<string, string | undefined> = process.env,
): RazorpayEnv | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

/** Basic auth, the way Razorpay wants it. `btoa` exists in Node 18+ and edge. */
function basic({ keyId, keySecret }: RazorpayEnv): string {
  const pair = keyId + ':' + keySecret;
  if (typeof btoa === 'function') return 'Basic ' + btoa(pair);
  return 'Basic ' + Buffer.from(pair, 'utf8').toString('base64');
}

interface OrderReply {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
}

interface PaymentsReply {
  items?: unknown;
}

interface SubscriptionReply {
  id?: unknown;
  status?: unknown;
}

function readText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function readPaise(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export function createRazorpayPayments(options: RazorpayPaymentsOptions = {}): Payments {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readRazorpayEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): RazorpayEnv {
    const found = env();
    if (!found) throw new Error('Razorpay is not configured');
    return found;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /** The PUBLIC key id. The secret is never returned from anywhere here. */
    keyId() {
      return env()?.keyId ?? null;
    },

    async createOrder({ amountInr, receipt, notes }: CreateOrderInput) {
      const keys = required();

      // F-G2 is kept upstream (Postgres decides `amountInr`), but a zero or
      // negative amount reaching a gateway is a bug worth refusing loudly:
      // Rs 0 is the A4 path and never gets this far.
      if (!Number.isFinite(amountInr) || amountInr <= 0) {
        throw new Error('Razorpay order needs a positive amount in rupees');
      }
      const trimmedReceipt = receipt.trim().slice(0, MAX_RECEIPT);
      if (trimmedReceipt.length === 0) {
        throw new Error('Razorpay order needs a receipt');
      }

      const res = await doFetch(API + '/orders', {
        method: 'POST',
        headers: {
          authorization: basic(keys),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          amount: toPaise(amountInr),
          currency: 'INR',
          receipt: trimmedReceipt,
          // Razorpay captures the payment itself, so the webhook in issue 27
          // sees `captured` rather than a hold we would have to settle.
          payment_capture: 1,
          ...(notes ? { notes } : {}),
        }),
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error('Razorpay order failed with status ' + res.status);
      }

      const body = (await res.json()) as OrderReply;
      const orderId = readText(body?.id);
      const amountPaise = readPaise(body?.amount);
      const currency = readText(body?.currency, 8);

      // A reply we cannot read is a FAILURE. Inventing an order id here would
      // send the student to a checkout that does not exist, and would write a
      // made-up id into a UNIQUE column (A1).
      if (!orderId || amountPaise === null || !currency) {
        throw new Error('Razorpay order reply could not be read');
      }

      return { orderId, amountPaise, currency };
    },

    /**
     * Separate from `isConfigured()` on purpose: the keys and the plan objects
     * are set up at different times, so a page can offer AI while Pro's plan
     * object is still being created in the console.
     */
    hasPlan(plan: Plan) {
      return env() !== null && readRazorpayPlanId(plan, options.env ?? process.env) !== null;
    },

    async createSubscription({ plan, notes }: CreateSubscriptionInput) {
      const keys = required();
      const planId = readRazorpayPlanId(plan, options.env ?? process.env);
      if (!planId) {
        throw new Error('Razorpay has no plan id for ' + plan);
      }

      const res = await doFetch(API + '/subscriptions', {
        method: 'POST',
        headers: {
          authorization: basic(keys),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          plan_id: planId,
          total_count: SUBSCRIPTION_TOTAL_COUNT,
          // Razorpay collects the first month itself and then every cycle,
          // and each collection arrives as `subscription.charged`, which is
          // the one event that extends `entitlements.valid_until` (0028).
          customer_notify: 1,
          ...(notes ? { notes } : {}),
        }),
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error('Razorpay subscription failed with status ' + res.status);
      }

      const body = (await res.json()) as SubscriptionReply;
      const subscriptionId = readText(body?.id, 80);
      const status = readText(body?.status, 32);

      // A reply we cannot read is a FAILURE. Inventing a subscription id would
      // write a made-up value into a UNIQUE column and leave the webhook
      // unable to find the row it is meant to extend.
      if (!subscriptionId || !status) {
        throw new Error('Razorpay subscription reply could not be read');
      }

      return { subscriptionId, status };
    },

    async fetchPayments(orderId: string) {
      const keys = required();
      const id = orderId.trim();
      if (id.length === 0) throw new Error('Razorpay needs an order id');

      const res = await doFetch(
        API + '/orders/' + encodeURIComponent(id) + '/payments?count=' + PAYMENTS_PER_PAGE,
        {
          method: 'GET',
          headers: { authorization: basic(keys), accept: 'application/json' },
          cache: 'no-store',
        },
      );

      if (!res.ok) {
        throw new Error('Razorpay payments read failed with status ' + res.status);
      }

      const body = (await res.json()) as PaymentsReply;
      const items = Array.isArray(body?.items) ? body.items : [];

      const out: PaymentRecord[] = [];
      for (const raw of items) {
        const one = raw as { id?: unknown; order_id?: unknown; amount?: unknown; status?: unknown };
        const paymentId = readText(one?.id);
        const amountPaise = readPaise(one?.amount);
        const status = readText(one?.status, 32);
        // A row we cannot read is DROPPED, not guessed. The nightly reconcile
        // (A6) would rather see a mismatch than a made-up `captured`.
        if (!paymentId || amountPaise === null || !status) continue;
        out.push({ paymentId, orderId: readText(one?.order_id), amountPaise, status });
      }
      return out;
    },
  };
}
