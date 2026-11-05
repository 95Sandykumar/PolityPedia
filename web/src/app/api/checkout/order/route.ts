/**
 * POST /api/checkout/order -> start buying one mock set
 * (issue 26-razorpay-order-checkout).
 *
 * Thin adapter. Every rule lives in `@/lib/purchases/checkout-route`, which
 * the tests drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token out of the httpOnly
 * session cookie, so `start_set_purchase()` reads `auth.uid()` as them. The
 * Razorpay secret is read from the environment HERE, on the server, and never
 * leaves: the reply holds the public key id and an order id only.
 *
 * F-G2: there is no amount in the request body that anything reads. Postgres
 * quotes the price from `mock_sets`.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the env holds
 * a payment secret.
 */
import { NextResponse } from 'next/server';
import { readSessionCookie } from '@/lib/teachers/read-session';
import { handleCheckoutOrder } from '@/lib/purchases/checkout-route';
import { createRazorpayPayments } from '@/lib/purchases/razorpay-payments';
import { createSupabaseCheckoutClient } from '@/lib/purchases/supabase-checkout-client';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleCheckoutOrder` answers 400 for it.
  }

  const reply = await handleCheckoutOrder({
    body,
    session,
    client: createSupabaseCheckoutClient({ accessToken: session?.accessToken ?? '' }),
    payments: createRazorpayPayments(),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
