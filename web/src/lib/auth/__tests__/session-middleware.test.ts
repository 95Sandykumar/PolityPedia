/**
 * Issue 33-session-refresh: what the middleware does with a dying token.
 *
 * The real `src/middleware.ts` is a two line adapter over `respondToRequest`,
 * so the rules are driven here with the fake auth client: no network call and
 * no key, the same as every other test in this suite.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createFakeAuthClient } from '../fake-auth-client';
import { SESSION_COOKIE, decodeSession, encodeSession, type AuthSession } from '../session';
import { respondToRequest } from '../session-middleware';

const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function request(pathname: string, session?: Partial<AuthSession> | null): NextRequest {
  const req = new NextRequest(new URL('https://politypedia.test' + pathname));
  if (session) {
    req.cookies.set(
      SESSION_COOKIE,
      encodeSession({
        accessToken: 'old.access.token',
        refreshToken: 'old-refresh',
        userId: '11111111-1111-4111-8111-111111111111',
        role: 'student',
        expiresAt: NOW_S + 3600,
        ...session,
      }),
    );
  }
  return req;
}

function cookieOf(res: Response & { cookies: { get(name: string): { value: string } | undefined } }) {
  return res.cookies.get(SESSION_COOKIE);
}

function location(res: Response): string | null {
  const raw = res.headers.get('location');
  return raw === null ? null : new URL(raw).pathname;
}

describe('respondToRequest', () => {
  it('rewrites the cookie with the new tokens and lets the request through', async () => {
    const fake = createFakeAuthClient({ nextExpiresAt: NOW_S + 3600 });
    const res = await respondToRequest({
      request: request('/t/teacher-1/papers/paper-1/play', { expiresAt: NOW_S + 60 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(fake.refreshCalls).toEqual(['old-refresh']);
    expect(res.status).toBe(200);
    expect(location(res)).toBeNull();

    const written = decodeSession(cookieOf(res)?.value);
    expect(written?.accessToken).toBe('new.access.token');
    expect(written?.refreshToken).toBe('new-refresh');
    expect(written?.expiresAt).toBe(NOW_S + 3600);
  });

  it('does not call Supabase for a fresh token', async () => {
    const fake = createFakeAuthClient();
    const res = await respondToRequest({
      request: request('/', { expiresAt: NOW_S + 3600 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(fake.refreshCalls).toEqual([]);
    expect(cookieOf(res)).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it('clears the cookie and sends a revoked session to sign-in', async () => {
    const fake = createFakeAuthClient({ failRefresh: true });
    const res = await respondToRequest({
      request: request('/t/teacher-1/papers/paper-1/play', { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(location(res)).toBe('/sign-in');
    expect(cookieOf(res)?.value).toBe('');
  });

  it('clears the cookie without a redirect loop on the sign-in page itself', async () => {
    const fake = createFakeAuthClient({ failRefresh: true });
    const res = await respondToRequest({
      request: request('/sign-in', { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    expect(location(res)).toBeNull();
    expect(res.status).toBe(200);
    expect(cookieOf(res)?.value).toBe('');
  });

  it('keeps the renewed cookie even when the guard redirects', async () => {
    const fake = createFakeAuthClient({ nextExpiresAt: NOW_S + 3600 });
    const res = await respondToRequest({
      request: request('/admin', { expiresAt: NOW_S - 1 }),
      client: fake.client,
      nowMs: NOW_MS,
    });

    // A student is still sent home, but with the new tokens in hand.
    expect(location(res)).toBe('/');
    expect(decodeSession(cookieOf(res)?.value)?.accessToken).toBe('new.access.token');
  });

  it('never refreshes on the auth routes, so the refresh token is spent once', async () => {
    const fake = createFakeAuthClient();
    for (const path of ['/api/auth/refresh', '/api/auth/sign-out', '/api/auth/verify-code']) {
      const res = await respondToRequest({
        request: request(path, { expiresAt: NOW_S - 1 }),
        client: fake.client,
        nowMs: NOW_MS,
      });
      expect(cookieOf(res)).toBeUndefined();
    }
    expect(fake.refreshCalls).toEqual([]);
  });

  it('leaves a visitor with no cookie alone', async () => {
    const fake = createFakeAuthClient();
    const res = await respondToRequest({ request: request('/'), client: fake.client, nowMs: NOW_MS });
    expect(fake.refreshCalls).toEqual([]);
    expect(cookieOf(res)).toBeUndefined();
    expect(res.status).toBe(200);
  });
});
