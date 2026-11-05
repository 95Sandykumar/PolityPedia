/**
 * GET  /api/admin/alerts  -> unresolved reconcile alerts, newest first
 * POST /api/admin/alerts  -> mark one resolved
 * (issue 35-reconcile-visible)
 *
 * Thin adapter. Every rule lives in `@/lib/ledger/admin-alerts-route`, which
 * the tests drive directly.
 *
 * The Supabase call carries the ADMIN'S OWN access token out of the httpOnly
 * session cookie, so the `reconcile_alerts_admin_all` policy in 0029 is the
 * real gate. There is NO service-role key in this route: the only thing in
 * this slice that holds one is the PM2 reconcile job, which never runs on
 * Vercel.
 *
 * Security: nothing here is logged. The cookie holds tokens, and a reply body
 * names somebody's payment and an amount.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';
import { handleAdminAlerts } from '@/lib/ledger/admin-alerts-route';
import { createSupabaseAlertsClient } from '@/lib/ledger/supabase-alerts-client';

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

  const reply = await handleAdminAlerts({
    method: 'GET',
    body: null,
    session,
    client: createSupabaseAlertsClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}

export async function POST(request: Request) {
  const session = readSession(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleAdminAlerts` answers 400 for it.
  }

  const reply = await handleAdminAlerts({
    method: 'POST',
    body,
    session,
    client: createSupabaseAlertsClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
