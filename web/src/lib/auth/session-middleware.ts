/**
 * What the middleware does on every request (issue 03-sign-in, renewal added
 * by issue 33-session-refresh).
 *
 * Three steps, in this order:
 *  1. Read the session cookie.
 *  2. Renew the access token if it is inside the two minute window. New tokens
 *     are written back into the SAME httpOnly cookie, so the request carries
 *     on signed in. A renewal that fails clears the cookie and the student is
 *     asked to sign in again.
 *  3. Ask the pure `guard()` for a verdict, then continue or redirect.
 *
 * `src/middleware.ts` is a two line adapter over this, because `config.matcher`
 * has to stay a literal string in that file (a Next.js build-time rule) and
 * because the tests need to hand in a fake auth client.
 *
 * This is a routing guard, not the security boundary. A forged cookie can
 * reach a page shell; it reads no data, because Postgres RLS checks the real
 * access-token JWT on every query.
 *
 * Security: nothing in this file is logged. The cookie holds tokens.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SIGN_IN_PATH, guard } from './guard';
import { refreshIfNeeded } from './refresh';
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
  type AuthSession,
} from './session';
import type { ServerAuthClient } from './types';

/**
 * Our own auth routes, which set or clear the cookie themselves.
 *
 * The middleware must NOT renew on these. Supabase rotates the refresh token,
 * so a renewal here would spend it, and the route handler reading the old
 * cookie off the request would then fail with a token that no longer exists
 * and sign the student out. One writer per request.
 */
const AUTH_ROUTES = '/api/auth';

function ownsItsCookie(pathname: string): boolean {
  return pathname === AUTH_ROUTES || pathname.startsWith(AUTH_ROUTES + '/');
}

export interface RespondInput {
  request: NextRequest;
  client: ServerAuthClient;
  nowMs?: number;
}

export async function respondToRequest({
  request,
  client,
  nowMs,
}: RespondInput): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const cookie = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);

  let session: AuthSession | null = cookie;
  /** Set when the cookie has to be rewritten with the renewed tokens. */
  let renewed: AuthSession | null = null;
  let clear = false;

  if (cookie && !ownsItsCookie(pathname)) {
    const outcome = await refreshIfNeeded({ session: cookie, client, nowMs });
    if (outcome.kind === 'refreshed') {
      session = outcome.session;
      renewed = outcome.session;
    } else if (outcome.kind === 'failed') {
      session = null;
      clear = true;
    }
  }

  if (clear) {
    // Already on the sign-in page: clear and stay, or the redirect loops.
    const response =
      pathname === SIGN_IN_PATH
        ? NextResponse.next()
        : NextResponse.redirect(new URL(SIGN_IN_PATH, request.nextUrl.origin));
    response.cookies.set(SESSION_COOKIE, '', clearedSessionCookieOptions());
    return response;
  }

  const verdict = guard({
    pathname,
    role: session?.role ?? null,
    // Issue 05: a teacher must be approved, not only a teacher.
    teacherStatus: session?.teacherStatus ?? null,
  });

  const response = verdict.allow
    ? NextResponse.next()
    : NextResponse.redirect(new URL(verdict.redirectTo, request.nextUrl.origin));

  // The renewed tokens go out even on a redirect: the student keeps the
  // session they just paid a network call for.
  if (renewed) {
    response.cookies.set(SESSION_COOKIE, encodeSession(renewed), sessionCookieOptions());
  }
  return response;
}
