/**
 * POST /api/auth/refresh  (issue 33-session-refresh)
 *
 * Renews the access token in the httpOnly cookie. The exam player calls this
 * once after a 401 and then sends the answer again, so a three hour mock test
 * is not lost at the hour mark.
 *
 * Thin adapter: every rule lives in `@/lib/auth/refresh`, which the tests
 * drive directly. The body carries no token, ever.
 */
import { NextResponse } from 'next/server';
import { handleRefresh } from '@/lib/auth/refresh';
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  encodeSession,
  sessionCookieOptions,
} from '@/lib/auth/session';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const reply = await handleRefresh({
    session: readSessionCookie(request),
    client: createSupabaseAuthClient(),
  });

  const response = NextResponse.json(
    reply.status === 200 ? { ok: true } : { error: 'sign in' },
    { status: reply.status },
  );
  if (reply.session) {
    response.cookies.set(SESSION_COOKIE, encodeSession(reply.session), sessionCookieOptions());
  }
  if (reply.clearCookie) {
    response.cookies.set(SESSION_COOKIE, '', clearedSessionCookieOptions());
  }
  return response;
}
