/**
 * Issue 38-session-and-alerts-fixes: an outage must not sign a student out,
 * and a foreign site must not be able to sign one out.
 *
 * Two bugs the re-check of issue 33 found:
 *
 *  1. `refreshIfNeeded` mapped EVERY thrown error to `failed`, so a Supabase
 *     5xx or a network timeout cleared the cookie. Mid-exam that turned an
 *     answer-save POST into a 307 to /sign-in, and the player's one 401 retry
 *     was never reached: the student lost the exam to somebody else's outage.
 *     Only 400 and 401 mean the refresh token itself is dead.
 *  2. `POST /api/auth/sign-out` cleared the cookie for ANY form POST, so a
 *     page on another site could sign the student out.
 *
 * No real network call and no real key: the auth client is the fake.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createBrowserAttemptsClient } from '@/lib/attempts/browser-attempts-client';
import { ATTEMPT_ANSWERS_PATH } from '@/lib/attempts/types';
import { REFRESH_PATH } from '../browser-auth-client';
import { createFakeAuthClient } from '../fake-auth-client';
import { SIGN_IN_PATH } from '../guard';
import { handleRefresh, refreshIfNeeded } from '../refresh';
import { SESSION_COOKIE, encodeSession, type AuthSession } from '../session';
import { respondToRequest } from '../session-middleware';
import { handleSignOut } from '../sign-out-route';

const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const SITE = 'https://politypedia.test';

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

function request(pathname: string, overrides: Partial<AuthSession> = {}): NextRequest {
  const req = new NextRequest(new URL(SITE + pathname));
  req.cookies.set(SESSION_COOKIE, encodeSession(session(overrides)));
  return req;
}

function location(res: Response): string | null {
  const raw = res.headers.get('location');
  return raw === null ? null : new URL(raw).pathname;
}

function cookieOf(res: { cookies: { get(name: string): { value: string } | undefined } }) {
  return res.cookies.get(SESSION_COOKIE);
}

// --------------------------------------------------------------------------
// 1. An outage is not a revoked token
// --------------------------------------------------------------------------

describe('refreshIfNeeded tells an outage apart from a dead token', () => {
  it('keeps the session when Supabase answers 500', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 500 });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(fake.refreshCalls).toHaveLength(1);
    if (outcome.kind !== 'unavailable') throw new Error('expected unavailable');
    // The SAME session comes back, so the caller leaves the cookie alone and
    // the old access token gets its chance: it may still have minutes left.
    expect(outcome.session.accessToken).toBe('old.access.token');
    expect(outcome.session.refreshToken).toBe('old-refresh');
  });

  it('keeps the session when the call times out', async () => {
    const fake = createFakeAuthClient({ failRefreshWith: 'timeout' });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('unavailable');
  });

  it('keeps the session when fetch itself throws', async () => {
    const fake = createFakeAuthClient({ failRefreshWith: 'network' });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('unavailable');
  });

  it('fails for 400, the status Supabase uses for a spent refresh token', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 400 });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('failed');
  });

  it('fails for 401, the status for a revoked token', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 401 });
    const outcome = await refreshIfNeeded({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });
    expect(outcome.kind).toBe('failed');
  });
});

describe('the middleware during an outage', () => {
  it('leaves the cookie alone and lets the page through on a 500', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 500 });
    const res = await respondToRequest({
      request: request('/t/teacher-1/papers/paper-1/play', { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(res.status).toBe(200);
    expect(location(res)).toBeNull();
    // Untouched: no new value and NO clearing value.
    expect(cookieOf(res)).toBeUndefined();
  });

  it('does not turn an answer-save POST into a redirect on a 500', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 500 });
    const res = await respondToRequest({
      request: request(ATTEMPT_ANSWERS_PATH, { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(res.status).toBe(200);
    expect(location(res)).toBeNull();
    expect(cookieOf(res)).toBeUndefined();
  });
});

describe('the middleware for a really dead token', () => {
  it('still clears the cookie and redirects a PAGE request', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 400 });
    const res = await respondToRequest({
      request: request('/t/teacher-1/papers/paper-1/play', { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(location(res)).toBe(SIGN_IN_PATH);
    expect(cookieOf(res)?.value).toBe('');
  });

  it('answers 401 JSON for an /api request instead of a 307 to a page', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 400 });
    const res = await respondToRequest({
      request: request(ATTEMPT_ANSWERS_PATH, { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(res.status).toBe(401);
    expect(location(res)).toBeNull();
    expect(cookieOf(res)?.value).toBe('');
    // A fetch caller can read this; a 307 to an HTML page it cannot.
    expect(await res.json()).toEqual({ error: 'sign in' });
  });
});

describe('handleRefresh (POST /api/auth/refresh) during an outage', () => {
  it('does NOT clear the cookie when Supabase answered 500', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 500 });
    const reply = await handleRefresh({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(reply.clearCookie).toBe(false);
    expect(reply.session).toBeNull();
    // 503 and not 200: nothing was renewed, so this must not read as success.
    expect(reply.status).toBe(503);
  });

  it('still clears the cookie and answers 401 for a dead refresh token', async () => {
    const fake = createFakeAuthClient({ refreshStatus: 401 });
    const reply = await handleRefresh({
      session: session({ expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(reply.status).toBe(401);
    expect(reply.clearCookie).toBe(true);
  });
});

describe('the answer-save helper still gets its one retry', () => {
  it('refreshes once after a 401 and sends the same answer again', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === REFRESH_PATH) return new Response('{"ok":true}', { status: 200 });
      // First save 401s (the hour ran out), the retry after the refresh works.
      const saves = calls.filter((one) => one === ATTEMPT_ANSWERS_PATH).length;
      return new Response('{}', { status: saves === 1 ? 401 : 200 });
    }) as typeof fetch;

    await createBrowserAttemptsClient(fetchImpl).saveAnswer({
      attemptId: '33333333-3333-4333-8333-333333333333',
      questionId: '44444444-4444-4444-8444-444444444444',
      chosenIdx: 2,
      isCorrect: null,
      marked: false,
    });

    expect(calls).toEqual([ATTEMPT_ANSWERS_PATH, REFRESH_PATH, ATTEMPT_ANSWERS_PATH]);
  });
});

// --------------------------------------------------------------------------
// 2. Sign out is ours alone
// --------------------------------------------------------------------------

describe('handleSignOut refuses a cross-site POST', () => {
  it('answers 403, clears nothing and revokes nothing for a foreign Origin', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleSignOut({
      session: session(),
      client: fake.client,
      origin: 'https://evil.test',
      siteOrigin: SITE,
    });

    expect(reply.status).toBe(403);
    expect(reply.clearCookie).toBe(false);
    // The session stays alive at Supabase too: another site does not get to
    // end somebody's exam.
    expect(fake.signOutCalls).toEqual([]);
  });

  it('refuses a missing Origin when Sec-Fetch-Site says cross-site', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleSignOut({
      session: session(),
      client: fake.client,
      origin: null,
      secFetchSite: 'cross-site',
      siteOrigin: SITE,
    });

    expect(reply.status).toBe(403);
    expect(reply.clearCookie).toBe(false);
    expect(fake.signOutCalls).toEqual([]);
  });

  it('works from the Me tab button: same Origin, same site', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleSignOut({
      session: session(),
      client: fake.client,
      origin: SITE,
      secFetchSite: 'same-origin',
      siteOrigin: SITE,
    });

    expect(reply.status).toBe(303);
    expect(reply.location).toBe(SIGN_IN_PATH);
    expect(reply.clearCookie).toBe(true);
    expect(fake.signOutCalls).toEqual(['old.access.token']);
  });

  it('accepts a missing Origin with no Sec-Fetch-Site at all (an old browser)', async () => {
    const fake = createFakeAuthClient();
    const reply = await handleSignOut({
      session: session(),
      client: fake.client,
      origin: null,
      siteOrigin: SITE,
    });

    expect(reply.status).toBe(303);
    expect(reply.clearCookie).toBe(true);
  });
});
