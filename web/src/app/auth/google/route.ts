/**
 * GET /auth/google  (issue 03-sign-in)
 * Starts Google sign-in: make a PKCE pair, park the verifier in a short
 * httpOnly cookie, send the browser to Supabase with the challenge.
 *
 * Security: the verifier is a secret and is never logged or put in a URL.
 */
import { NextResponse } from 'next/server';
import { VERIFIER_COOKIE, VERIFIER_MAX_AGE_SECONDS, challengeFor, createVerifier } from '@/lib/auth/pkce';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';
import { SIGN_IN_PATH } from '@/lib/auth/guard';

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const client = createSupabaseAuthClient();

  if (!client.isConfigured()) {
    return NextResponse.redirect(new URL(SIGN_IN_PATH + '?error=not_configured', origin));
  }

  const verifier = createVerifier();
  const challenge = await challengeFor(verifier);
  const target = client.googleAuthorizeUrl(origin + '/auth/callback', challenge);

  const response = NextResponse.redirect(target);
  response.cookies.set(VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: VERIFIER_MAX_AGE_SECONDS,
  });
  return response;
}
