/**
 * POST /api/checkout/subscription -> start a monthly plan
 * (issue 28-plan-subscriptions).
 *
 * Thin adapter. Every rule lives in `@/lib/plans/subscribe-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token out of the httpOnly
 * session cookie, so `start_plan_subscription()` reads `auth.uid()` as them.
 * The Razorpay secret is read from the environment HERE, on the server, and
 * never leaves: the reply holds the public key id and a subscription id only.
 *
 * F-G2: there is no amount in the request body that anything reads. Postgres
 * quotes the price from `plan_price_inr()`.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the env holds
 * a payment secret.
 */
import { NextResponse } from 'next/server';
import { handleSubscribe } from '@/lib/plans/subscribe-route';
import { createSupabaseSubscriptionsClient } from '@/lib/plans/supabase-subscriptions-client';
import { createRazorpayPayments } from '@/lib/purchases/razorpay-payments';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleSubscribe` answers 400 for it.
  }

  const reply = await handleSubscribe({
    body,
    session,
    client: createSupabaseSubscriptionsClient({ accessToken: session?.accessToken ?? '' }),
    payments: createRazorpayPayments(),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
