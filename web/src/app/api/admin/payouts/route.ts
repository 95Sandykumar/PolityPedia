/**
 * GET  /api/admin/payouts  -> unpaid earnings per teacher per month
 * POST /api/admin/payouts  -> record the monthly bank transfer
 * (issue 29-ledger-reconcile-payouts)
 *
 * Thin adapter. Every rule lives in `@/lib/ledger/admin-payouts-route`, which
 * the tests drive directly.
 *
 * The Supabase call carries the ADMIN'S OWN access token out of the httpOnly
 * session cookie, so the `is_admin()` guard inside `payout_report()` and
 * `mark_payout_paid()` is the real gate. There is NO service-role key in this
 * route: the only thing in this slice that holds one is the PM2 reconcile job,
 * which never runs on Vercel.
 *
 * Security: nothing here is logged. The cookie holds tokens, and a reply body
 * would name a teacher and an amount.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';
import { handleAdminPayouts } from '@/lib/ledger/admin-payouts-route';
import { createSupabasePayoutsClient } from '@/lib/ledger/supabase-payouts-client';

/** Read our one session cookie off the raw header. Never throws. */
function readSession(request: Request): AuthSession | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    return decodeSession(part.slice(at + 1).trim());
  }
  return null;
}

export async function GET(request: Request) {
  const session = readSession(request);

  const reply = await handleAdminPayouts({
    method: 'GET',
    body: null,
    period: new URL(request.url).searchParams.get('period'),
    session,
    client: createSupabasePayoutsClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}

export async function POST(request: Request) {
  const session = readSession(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleAdminPayouts` answers 400 for it.
  }

  const reply = await handleAdminPayouts({
    method: 'POST',
    body,
    session,
    client: createSupabasePayoutsClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
