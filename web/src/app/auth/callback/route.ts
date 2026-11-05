/**
 * GET /auth/callback  (issue 03-sign-in)
 * Supabase sends the browser back here with `?code=`. Swap it for a session
 * using the parked PKCE verifier, set the session cookie, go to Home.
 *
 * The profiles row is created by the database, not here: migration
 * 0003_profile_on_signup.sql has a trigger on auth.users, so a first sign-in
 * always has a row with role `student` before this route reads its role.
 *
 * Security: no code, verifier or token is logged, and none reaches a URL.
 */
import { NextResponse } from 'next/server';
import { HOME_PATH, SIGN_IN_PATH } from '@/lib/auth/guard';
import { VERIFIER_COOKIE } from '@/lib/auth/pkce';
import { SESSION_COOKIE, encodeSession, sessionCookieOptions } from '@/lib/auth/session';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';
import { cookies } from 'next/headers';

function backToSignIn(origin: string, reason: string) {
  return NextResponse.redirect(new URL(SIGN_IN_PATH + '?error=' + reason, origin));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  // Supabase reports a refusal here (user cancelled, provider error).
  if (url.searchParams.get('error')) return backToSignIn(origin, 'denied');

  const code = url.searchParams.get('code');
  if (!code) return backToSignIn(origin, 'no_code');

  const client = createSupabaseAuthClient();
  if (!client.isConfigured()) return backToSignIn(origin, 'not_configured');

  const jar = await cookies();
  const verifier = jar.get(VERIFIER_COOKIE)?.value;
  if (!verifier) return backToSignIn(origin, 'expired');

  let session;
  try {
    session = await client.exchangeCodeForSession(code, verifier);
  } catch {
    return backToSignIn(origin, 'failed');
  }

  const response = NextResponse.redirect(new URL(HOME_PATH, origin));
  response.cookies.set(SESSION_COOKIE, encodeSession(session), sessionCookieOptions());
  response.cookies.delete(VERIFIER_COOKIE);
  return response;
}
