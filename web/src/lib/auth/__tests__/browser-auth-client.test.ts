/**
 * Issue 03-sign-in: the browser-side AuthClient.
 *
 * The browser never holds a Supabase key. It calls our own route handlers,
 * which set the httpOnly session cookie. `fetch` is injected, so no real call.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBrowserAuthClient } from '../browser-auth-client';
import { reasonOf } from '../sign-in-errors';

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : '{}', { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('createBrowserAuthClient', () => {
  it('posts the email to the send-code route', async () => {
    const { fn, calls } = fakeFetch();
    await createBrowserAuthClient(fn).sendEmailCode('a@b.test');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/auth/send-code');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'a@b.test' });
  });

  it('posts the email and code to the verify route', async () => {
    const { fn, calls } = fakeFetch();
    await createBrowserAuthClient(fn).verifyEmailCode('a@b.test', '123456');

    expect(calls[0].url).toBe('/api/auth/verify-code');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'a@b.test', code: '123456' });
  });

  it('throws on a failed response without echoing the code', async () => {
    const { fn } = fakeFetch(403);
    const error = await createBrowserAuthClient(fn)
      .verifyEmailCode('a@b.test', '123456')
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('123456');
  });

  it('carries the reason from the route so the page can pick a message', async () => {
    const fn = vi.fn(
      async () => new Response(JSON.stringify({ error: 'verify failed', reason: 'expired' }), { status: 401 }),
    ) as unknown as typeof fetch;
    const error = await createBrowserAuthClient(fn)
      .verifyEmailCode('a@b.test', '123456')
      .catch((e: unknown) => e);
    expect(reasonOf(error)).toBe('expired');
  });

  it('falls back to failed when the body has no known reason', async () => {
    const { fn } = fakeFetch(500);
    const error = await createBrowserAuthClient(fn).sendEmailCode('a@b.test').catch((e: unknown) => e);
    expect(reasonOf(error)).toBe('failed');
  });
});
