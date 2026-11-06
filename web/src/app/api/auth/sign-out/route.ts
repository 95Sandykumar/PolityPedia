/**
 * POST /api/auth/sign-out  (issue 33-session-refresh)
 *
 * Revokes the session at Supabase, clears the httpOnly cookie and sends the
 * browser to /sign-in with a 303, so a plain form POST works with no
 * JavaScript at all (the Me tab button is a form, for bad 4G).
 *
 * Only OUR OWN pages may ask (issue 38-session-and-alerts-fixes): the two
 * headers go in, and a foreign `Origin` comes back 403 with the cookie
 * untouched.
 *
 * Thin adapter: the rules live in `@/lib/auth/sign-out-route`.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, clearedSessionCookieOptions } from '@/lib/auth/session';
import { handleSignOut } from '@/lib/auth/sign-out-route';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const reply = await handleSignOut({
    session: readSessionCookie(request),
    client: createSupabaseAuthClient(),
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    // Our own origin, as this very request names it.
    siteOrigin: new URL(request.url).origin,
  });

  if (reply.status === 403) {
    // Fixed body, and NO cookie header at all: a foreign page gets told no
    // and learns nothing about whether anybody was signed in.
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const response = NextResponse.redirect(new URL(reply.location, request.url), reply.status);
  response.cookies.set(SESSION_COOKIE, '', clearedSessionCookieOptions());
  return response;
}
