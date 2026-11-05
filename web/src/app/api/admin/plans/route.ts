/**
 * POST   /api/admin/plans  -> grant or extend a plan
 * DELETE /api/admin/plans  -> end a plan now
 * (issue 21-plans-entitlements)
 *
 * Thin adapter. Every rule lives in `@/lib/plans/admin-plans-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the ADMIN'S OWN access token out of the httpOnly
 * session cookie, so the `entitlements_admin_all` RLS policy inside Postgres is
 * the real gate. There is no service-role key in this route.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';
import { handleAdminPlans } from '@/lib/plans/admin-plans-route';
import { createSupabasePlansClient } from '@/lib/plans/supabase-plans-client';

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

async function run(request: Request, method: 'POST' | 'DELETE') {
  const session = readSession(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleAdminPlans` answers 400 for it.
  }

  const reply = await handleAdminPlans({
    method,
    body,
    session,
    client: createSupabasePlansClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}

export function POST(request: Request) {
  return run(request, 'POST');
}

export function DELETE(request: Request) {
  return run(request, 'DELETE');
}
