/**
 * Issue 33-session-refresh: POST /api/auth/sign-out.
 *
 * On a shared phone the 7 day cookie was the whole problem: it was only ever
 * set, never cleared. Signing out revokes the session at Supabase AND clears
 * the cookie, then the browser lands on /sign-in.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAuthClient } from '../fake-auth-client';
import { SIGN_IN_PATH } from '../guard';
import { handleSignOut } from '../sign-out-route';
import type { AuthSession } from '../session';

const session: AuthSession = {
  accessToken: 'a.b.c',
  refreshToken: 'r-1',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
  expiresAt: 1_800_003_600,
};

describe('handleSignOut', () => {
  it('revokes the session once and sends the browser to sign-in', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleSignOut({ session, client: fake.client });

    expect(fake.signOutCalls).toEqual(['a.b.c']);
    expect(reply.clearCookie).toBe(true);
    expect(reply.status).toBe(303);
    expect(reply.location).toBe(SIGN_IN_PATH);
  });

  it('still clears the cookie when Supabase refuses the revoke', async () => {
    const fake = createFakeAuthClient({ failSignOut: true });
    const reply = await handleSignOut({ session, client: fake.client });

    expect(fake.signOutCalls).toHaveLength(1);
    expect(reply.clearCookie).toBe(true);
    expect(reply.location).toBe(SIGN_IN_PATH);
  });

  it('clears the cookie with no call when nobody is signed in', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleSignOut({ session: null, client: fake.client });

    expect(fake.signOutCalls).toEqual([]);
    expect(reply.clearCookie).toBe(true);
    expect(reply.location).toBe(SIGN_IN_PATH);
  });

  it('clears the cookie with no call when Supabase is not configured', async () => {
    const fake = createFakeAuthClient({ configured: false });
    const reply = await handleSignOut({ session, client: fake.client });

    expect(fake.signOutCalls).toEqual([]);
    expect(reply.clearCookie).toBe(true);
  });
});
