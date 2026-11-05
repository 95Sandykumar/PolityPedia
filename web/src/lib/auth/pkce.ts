/**
 * PKCE for the Google sign-in flow (issue 03-sign-in, RFC 7636).
 *
 * `/auth/google` makes a verifier, keeps it in a short httpOnly cookie, and
 * sends the S256 challenge to Supabase. `/auth/callback` swaps the returned
 * `?code=` plus the verifier for a session. Uses Web Crypto only, so it runs
 * in the Node and the Edge runtime without a dependency.
 *
 * Security: a verifier is a secret. Never log it.
 */

export const VERIFIER_COOKIE = 'pp_pkce';

/** Short life: the user is mid-redirect, not mid-session. */
export const VERIFIER_MAX_AGE_SECONDS = 600;

/** 32 random bytes as base64url = 43 characters, the RFC 7636 minimum. */
export function createVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
