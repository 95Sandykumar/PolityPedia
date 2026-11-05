/**
 * POST /api/webhooks/razorpay -> the money arrived, or went back
 * (issue 27-razorpay-webhook-ledger).
 *
 * Thin adapter. Every rule lives in `@/lib/purchases/webhook`, which the tests
 * drive directly, and the three state moves live in `0027_ledger.sql`.
 *
 * `request.text()` AND NOT `request.json()`, and that is the whole reason this
 * file is separate from the checkout route. The signature is an HMAC over the
 * RAW BYTES of the body. Parsing to an object and re-serialising changes those
 * bytes (key order, spacing, number formatting), so a `request.json()` here
 * would make the signature uncheckable and A2 unenforceable. The raw string is
 * read once, checked, and only then parsed.
 *
 * `runtime = 'nodejs'` because `node:crypto`'s `timingSafeEqual` is what the
 * signature is compared with.
 *
 * This route takes NO cookie and NO bearer token: anybody on the internet may
 * call it, and the signature is the entire authentication. It is also the only
 * route that carries the service-role key, because the four SQL functions it
 * needs are granted to `service_role` alone (see 0027's closing note).
 *
 * Security: nothing here is logged. The body carries a payment id and can
 * carry an email, the signature header is derived from a secret, and the env
 * holds two secrets.
 */
import { NextResponse } from 'next/server';
import { createSupabaseWebhookStore } from '@/lib/purchases/supabase-webhook-store';
import {
  handleRazorpayWebhook,
  readWebhookSecret,
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
} from '@/lib/purchases/webhook';

export const runtime = 'nodejs';

/** A webhook is never cached and never pre-rendered. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // The body EXACTLY as it arrived. Read once: a request body is a stream.
  const rawBody = await request.text();

  const reply = await handleRazorpayWebhook({
    rawBody,
    signature: request.headers.get(RAZORPAY_SIGNATURE_HEADER),
    eventIdHeader: request.headers.get(RAZORPAY_EVENT_ID_HEADER),
    secret: readWebhookSecret(),
    store: createSupabaseWebhookStore(),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
