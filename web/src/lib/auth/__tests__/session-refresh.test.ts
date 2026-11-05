/**
 * Issue 33-session-refresh: renew the access token before it dies.
 *
 * A mock test can run 360 minutes (`mock_tests.duration_min`) and a Supabase
 * access token lasts about one hour, so without this the student's answers
 * stop saving at minute 60 of a three hour exam.
 *
 * No real network call and no real key: the auth client is the fake.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAuthClient } from '../fake-auth-client';
import { handleRefresh, refreshIfNeeded } from '../refresh';
import {
  REFRESH_SKEW_SECONDS,
  clearedSessionCookieOptions,
  decodeSession,
  encodeSession,
  needsRefresh,
  sessionCookieOptions,
  type AuthSession,
} from '../session';

const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'old.access.token',
    refreshToken: 'old-refresh',
    userId: '11111111-1111-4111-8111-111111111111',
    role: 'student',
    expiresAt: NOW_S + 3600,
    ...overrides,
  };
}

describe('the cookie records when the access token expires', () => {
  it('round-trips expiresAt', () => {
    const one = session();
    expect(decodeSession(encodeSession(one))).toEqual(one);
  });

  it('drops an expiresAt that is not a number instead of refusing the cookie', () => {
    const raw = Buffer.from(JSON.stringify({ ...session(), expiresAt: 'soon' })).toString(
      'base64url',
    );
    const decoded = decodeSession(raw);
    expect(decoded).not.toBeNull();
    expect(decoded?.expiresAt).toBeUndefined();
  });
});

describe('needsRefresh', () => {
  it('leaves a fresh token alone', () => {
    expect(needsRefresh(session({ expiresAt: NOW_S + 3600 }), NOW_MS)).toBe(false);
  });

  it('refreshes inside the two minute window', () => {
    expect(REFRESH_SKEW_SECONDS).toBe(120);
    expect(needsRefresh(session({ expiresAt: NOW_S + 119 }), NOW_MS)).toBe(true);
    expect(needsRefresh(session({ expiresAt: NOW_S + 121 }), NOW_MS)).toBe(false);
  });

  it('refreshes a token that already expired', () => {
    expect(needsRefresh(session({ expiresAt: NOW_S - 10 }), NOW_MS)).toBe(true);
  });

  it('refreshes a cookie written before this issue, which has no expiry', () => {
    expect(needsRefresh(session({ expiresAt: undefined }), NOW_MS)).toBe(true);
  });
});

describe('refreshIfNeeded', () => {
  it('does not call Supabase for a fresh token', async () => {
    const fake = createFakeAuthClient();
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S + 3600 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('fresh');
    expect(fake.refreshCalls).toEqual([]);
  });

  it('swaps a near-expiry token for a new one, with a new expiry', async () => {
    const fake = createFakeAuthClient({ nextExpiresAt: NOW_S + 3600 });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S + 30 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(fake.refreshCalls).toEqual(['old-refresh']);
    if (outcome.kind !== 'refreshed') throw new Error('expected a refreshed session');
    expect(outcome.session.accessToken).toBe('new.access.token');
    expect(outcome.session.refreshToken).toBe('new-refresh');
    expect(outcome.session.expiresAt).toBe(NOW_S + 3600);
    // Same person, so the cookie keeps pointing at the same user.
    expect(outcome.session.userId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('fails when the refresh token was revoked', async () => {
    const fake = createFakeAuthClient({ failRefresh: true });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('failed');
    expect(fake.refreshCalls).toHaveLength(1);
  });

  it('fails without a call when there is no refresh token to spend', async () => {
    const fake = createFakeAuthClient();
    const outcome = await refreshIfNeeded({
      session: session({ refreshToken: '', expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('failed');
    expect(fake.refreshCalls).toEqual([]);
  });

  it('leaves the session alone when Supabase is not configured', async () => {
    const fake = createFakeAuthClient({ configured: false });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('fresh');
    expect(fake.refreshCalls).toEqual([]);
  });
});

describe('the cleared cookie', () => {
  it('keeps every flag of the real cookie and expires at once', () => {
    const cleared = clearedSessionCookieOptions({ NODE_ENV: 'production' });
    const live = sessionCookieOptions({ NODE_ENV: 'production' });
    expect(cleared.httpOnly).toBe(true);
    expect(cleared.sameSite).toBe('lax');
    expect(cleared.path).toBe('/');
    expect(cleared.secure).toBe(true);
    expect(live.secure).toBe(true);
    expect(cleared.maxAge).toBe(0);
  });

  it('is not Secure on a local dev box, so sign out still works there', () => {
    expect(clearedSessionCookieOptions({ NODE_ENV: 'development' }).secure).toBe(false);
  });
});

describe('handleRefresh (POST /api/auth/refresh)', () => {
  it('hands back the new session for the cookie', async () => {
    const fake = createFakeAuthClient({ nextExpiresAt: NOW_S + 3600 });
    const reply = await handleRefresh({
      session: session({ expiresAt: NOW_S + 10 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(reply.status).toBe(200);
    expect(reply.session?.accessToken).toBe('new.access.token');
    expect(reply.clearCookie).toBe(false);
  });

  it('answers 200 and writes nothing when the token was still good', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleRefresh({
      session: session({ expiresAt: NOW_S + 3600 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(reply.status).toBe(200);
    expect(reply.session).toBeNull();
    expect(fake.refreshCalls).toEqual([]);
  });

  it('answers 401 and clears the cookie for a revoked session', async () => {
    const fake = createFakeAuthClient({ failRefresh: true });
    const reply = await handleRefresh({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(reply.status).toBe(401);
    expect(reply.clearCookie).toBe(true);
  });

  it('answers 401 for a caller with no cookie at all', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleRefresh({ session: null, client: fake.client, nowMs: NOW_MS });

    expect(reply.status).toBe(401);
    expect(reply.clearCookie).toBe(true);
    expect(fake.refreshCalls).toEqual([]);
  });
});
