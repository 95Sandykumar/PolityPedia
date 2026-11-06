/**
 * What the middleware does on every request (issue 03-sign-in, renewal added
 * by issue 33-session-refresh).
 *
 * Three steps, in this order:
 *  1. Read the session cookie.
 *  2. Renew the access token if it is inside the two minute window. New tokens
 *     are written back into the SAME httpOnly cookie, so the request carries
 *     on signed in. A renewal SUPABASE REFUSED clears the cookie and the
 *     student is asked to sign in again; a renewal that could not be made at
 *     all (a 5xx, a timeout, a dead network) changes nothing and the request
 *     carries on with the cookie it arrived with
 *     (issue 38-session-and-alerts-fixes).
 *  3. Ask the pure `guard()` for a verdict, then continue or redirect.
 *
 * An `/api/*` request is never redirected (issue 38-session-and-alerts-fixes).
 * A 307 to an HTML sign-in page is not an answer a `fetch` caller can read: it
 * follows the redirect, gets a page, and the player's one 401 retry never
 * happens. API paths get `401 {"error":"sign in"}` instead.
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

/** Everything the browser calls with `fetch` rather than by navigating. */
const API_ROUTES = '/api';

function isApiPath(pathname: string): boolean {
  return pathname === API_ROUTES || pathname.startsWith(API_ROUTES + '/');
}

/**
 * What a request with a dead session gets back.
 *
 * Three different answers, because three different callers ask
 * (issue 38-session-and-alerts-fixes):
 *
 *  * an `/api/*` call gets 401 JSON. It was made with `fetch`, so a redirect
 *    to an HTML page would be followed silently and read as a success body;
 *    that is exactly how a 307 ate the exam player's 401 retry.
 *  * the sign-in page itself gets to stay where it is, or the redirect loops.
 *  * every other page gets sent to sign-in.
 */
function refusedResponse(pathname: string, request: NextRequest): NextResponse {
  if (isApiPath(pathname)) {
    return NextResponse.json({ error: 'sign in' }, { status: 401 });
  }
  if (pathname === SIGN_IN_PATH) return NextResponse.next();
  return NextResponse.redirect(new URL(SIGN_IN_PATH, request.nextUrl.origin));
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
    // `unavailable` falls through ON PURPOSE: Supabase could not be reached,
    // so nothing is known, the cookie is left exactly as it arrived and the
    // request continues with it (issue 38-session-and-alerts-fixes).
  }

  if (clear) {
    const response = refusedResponse(pathname, request);
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
