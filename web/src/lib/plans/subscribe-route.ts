/**
 * The decision logic behind POST /api/checkout/subscription
 * (issue 28-plan-subscriptions).
 *
 * Kept out of the route file so the tests drive it directly, the same split as
 * `checkout-route.ts` in issue 26. The route file is a thin adapter.
 *
 * The order of the steps IS the design, and it is deliberately the same shape
 * as the mock-set checkout, so a reader who knows one knows both:
 *
 *   1. session   -- no cookie, no subscription. Before any database call.
 *   2. body      -- A PLAN NAME, and nothing else. THE AMOUNT IS NOT READ.
 *                   F-G2: "the price always comes from our database, never
 *                   from the phone." There is no code here that looks at an
 *                   amount, so there is no code to forget to validate.
 *   3. start()   -- `start_plan_subscription()` in Postgres quotes the price
 *                   and decides whether this student may subscribe at all
 *                   (PP409 when they already have the plan), in ONE
 *                   transaction. This file never decides any of it.
 *   4. the gateway -- only now, and only when BOTH the keys and this plan's
 *                   Razorpay plan object exist.
 *   5. attach    -- Razorpay's subscription id goes back on our row before
 *                   the student is sent to pay, because that id is the ONLY
 *                   thing the webhook will arrive with. If it will not stick,
 *                   the checkout does NOT open.
 *
 * WHY THERE IS NO "FREE" BRANCH, unlike issue 26. A mock set can cost Rs 0
 * through a 100% coupon, and A4 handles it. V18's plans cost Rs 100 and Rs
 * 500, full stop; the free tier is the ABSENCE of an `entitlements` row, not a
 * Rs 0 subscription. A coupon on a plan is not v1.
 *
 * Security: every reply is one of a fixed list of codes. A thrown error may
 * quote Razorpay, PostgREST or a constraint name, and none of those belong in
 * a browser. Nothing in this file logs.
 */
import type { AuthSession } from '@/lib/auth/types';
import { PurchaseError, type Payments, type PurchaseFailure } from '@/lib/purchases/types';
import { isPlan, type Plan, type SubscribeStart, type SubscriptionsClient } from './types';

export interface SubscribeInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: SubscriptionsClient;
  payments: Payments;
}

/** The codes the UI switches on. Same list as the mock-set checkout. */
export type SubscribeError = PurchaseFailure | 'bad_request' | 'not_configured' | 'gateway';

export type SubscribeReply =
  | { status: 200; body: SubscribeStart }
  | { status: number; body: { error: SubscribeError } };

/** HTTP status per refusal. One place, so a code and a status never drift. */
const STATUS_BY_FAILURE: Record<PurchaseFailure, number> = {
  sign_in: 401,
  not_found: 404,
  owned: 409,
  own_set: 403,
  coupon: 422,
  failed: 502,
};

function fail(status: number, error: SubscribeError): SubscribeReply {
  return { status, body: { error } };
}

/**
 * Read the ONE thing a subscribe request is allowed to carry.
 *
 * Everything else in the body is dropped on the floor, which is what makes
 * F-G2 true by construction rather than by a check somebody has to remember.
 */
function readPlan(body: unknown): Plan | null {
  if (typeof body !== 'object' || body === null) return null;
  const { plan } = body as Record<string, unknown>;
  return isPlan(plan) ? plan : null;
}

export async function handleSubscribe({
  body,
  session,
  client,
  payments,
}: SubscribeInput): Promise<SubscribeReply> {
  if (!session) return fail(401, 'sign_in');

  const plan = readPlan(body);
  if (!plan) return fail(400, 'bad_request');

  if (!client.isConfigured()) return fail(503, 'not_configured');

  // CHECKED BEFORE THE DATABASE CALL, and that is the one place this route
  // differs from issue 26's order. A mock-set purchase can finish without the
  // gateway (A4's Rs 0 path), so its `isConfigured()` check sits after the
  // start. A subscription cannot: Razorpay is the only thing that can collect
  // a monthly payment, so starting a row we could never charge would leave a
  // `created` subscription behind for nothing.
  const keyId = payments.keyId();
  if (!payments.isConfigured() || !keyId || !payments.hasPlan(plan)) {
    return fail(503, 'not_configured');
  }

  let started;
  try {
    started = await client.start(plan);
  } catch (error) {
    const code: PurchaseFailure = error instanceof PurchaseError ? error.code : 'failed';
    return fail(STATUS_BY_FAILURE[code], code);
  }

  let subscription;
  try {
    subscription = await payments.createSubscription({
      plan,
      // Our own row id, so a human in the Razorpay console can get from a
      // subscription back to our table. Short string, no email, no user id.
      notes: { subscription_id: started.subscriptionId },
    });
  } catch {
    return fail(502, 'gateway');
  }

  try {
    await client.attachSubscriptionId(started.subscriptionId, subscription.subscriptionId);
  } catch {
    // The subscription exists at Razorpay but we cannot point our row at it,
    // so the webhook would never find it and every month collected would
    // grant nothing. Refuse rather than take the money blind.
    return fail(502, 'gateway');
  }

  return {
    status: 200,
    body: {
      subscriptionId: started.subscriptionId,
      razorpaySubscriptionId: subscription.subscriptionId,
      // The rupees POSTGRES quoted. The request body never reaches here.
      amountInr: started.amountInr,
      plan,
      keyId,
    },
  };
}
