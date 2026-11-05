/**
 * The decision logic behind POST /api/checkout/order
 * (issue 26-razorpay-order-checkout).
 *
 * Kept out of the route file so the tests drive it directly, the same split as
 * `admin-set-access-route.ts` and `revision-route.ts`. The route file is a
 * thin adapter.
 *
 * The order of the steps IS the design:
 *
 *   1. session   -- no cookie, no order. Before any database call.
 *   2. body      -- a set id, and a coupon if the student typed one. THE
 *                   AMOUNT IS NOT READ. F-G2: "the price always comes from
 *                   our database, never from the phone." There is no code
 *                   here that looks at an amount, so there is no code to
 *                   forget to validate.
 *   3. start()   -- `start_set_purchase()` in Postgres decides the price, the
 *                   coupon and whether this student may buy at all, in ONE
 *                   transaction. This file never decides any of it.
 *   4. Rs 0      -- A4. The database has already written `purchases` paid and
 *                   `set_access`, so the answer is "free" and Razorpay is
 *                   never called. Not called with a zero amount: NOT CALLED.
 *   5. the order -- only for a real amount, and the rupees come from step 3.
 *   6. attach    -- the order id goes back on our row before the student is
 *                   sent to pay, so issue 27's webhook can find the purchase.
 *                   If it will not stick, the checkout does NOT open.
 *
 * Security: every reply is one of a fixed list of codes. A thrown error may
 * quote Razorpay, PostgREST or a constraint name, and none of those belong in
 * a browser. Nothing in this file logs.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  isUuid,
  normaliseCoupon,
  PurchaseError,
  type CheckoutClient,
  type CheckoutStart,
  type Payments,
  type PurchaseFailure,
} from './types';

export interface CheckoutOrderInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: CheckoutClient;
  payments: Payments;
}

/** The codes the UI switches on. */
export type CheckoutError = PurchaseFailure | 'bad_request' | 'not_configured' | 'gateway';

export type CheckoutReply =
  | { status: 200; body: CheckoutStart }
  | { status: number; body: { error: CheckoutError } };

/** HTTP status per refusal. One place, so a code and a status never drift. */
const STATUS_BY_FAILURE: Record<PurchaseFailure, number> = {
  sign_in: 401,
  not_found: 404,
  owned: 409,
  own_set: 403,
  coupon: 422,
  failed: 502,
};

function fail(status: number, error: CheckoutError): CheckoutReply {
  return { status, body: { error } };
}

/**
 * Read the ONLY two things a checkout request is allowed to carry.
 *
 * Everything else in the body is dropped on the floor, which is what makes
 * F-G2 true by construction rather than by a check somebody has to remember.
 */
function readRequest(body: unknown): { setId: string; coupon: string | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { set_id: setId, coupon } = body as Record<string, unknown>;
  if (!isUuid(setId)) return null;
  return { setId, coupon: normaliseCoupon(coupon) };
}

export async function handleCheckoutOrder({
  body,
  session,
  client,
  payments,
}: CheckoutOrderInput): Promise<CheckoutReply> {
  if (!session) return fail(401, 'sign_in');

  const request = readRequest(body);
  if (!request) return fail(400, 'bad_request');

  if (!client.isConfigured()) return fail(503, 'not_configured');

  let started;
  try {
    started = await client.start(request);
  } catch (error) {
    const code: PurchaseFailure = error instanceof PurchaseError ? error.code : 'failed';
    return fail(STATUS_BY_FAILURE[code], code);
  }

  // A4. The zero-price path is already finished inside Postgres, so it must
  // not depend on Razorpay being set up at all. This return is above the
  // `isConfigured()` check on purpose.
  if (started.status === 'paid' || started.amountInr === 0) {
    return { status: 200, body: { free: true, purchaseId: started.purchaseId } };
  }

  const keyId = payments.keyId();
  // A `created` purchase with no order is harmless: it has no order id, it
  // never becomes `paid`, and the reconcile (A6) only looks at paid rows.
  // Sending the student to a checkout we cannot open would not be harmless.
  if (!payments.isConfigured() || !keyId) return fail(503, 'not_configured');

  let order;
  try {
    order = await payments.createOrder({
      // The rupees POSTGRES quoted. The request body never reaches here.
      amountInr: started.amountInr,
      receipt: started.purchaseId,
    });
  } catch {
    return fail(502, 'gateway');
  }

  try {
    await client.attachOrderId(started.purchaseId, order.orderId);
  } catch {
    // The order exists at Razorpay but we cannot point our row at it, so the
    // webhook would never match it. Refuse rather than take the money blind.
    return fail(502, 'gateway');
  }

  return {
    status: 200,
    body: {
      free: false,
      purchaseId: started.purchaseId,
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      currency: order.currency,
      keyId,
    },
  };
}
