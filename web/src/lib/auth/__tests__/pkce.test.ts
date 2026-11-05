/**
 * Issue 03-sign-in: PKCE pair for the Google sign-in flow.
 * Supabase hands back `?code=` and we swap it for a session using the verifier.
 */
import { describe, expect, it } from 'vitest';
import { challengeFor, createVerifier } from '../pkce';

describe('pkce', () => {
  it('makes a fresh high-entropy verifier every time', () => {
    const a = createVerifier();
    const b = createVerifier();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('derives a stable base64url S256 challenge', async () => {
    // RFC 7636 appendix B test vector.
    const challenge = await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is deterministic for the same verifier', async () => {
    const v = createVerifier();
    expect(await challengeFor(v)).toBe(await challengeFor(v));
  });
});
