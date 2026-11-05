/**
 * Issue 03-sign-in: the server-side AuthClient that talks to Supabase Auth.
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object with obvious dummy values.
 */
import { describe, expect, it, vi } from 'vitest';
import { readSupabaseEnv } from '../env';
import { createSupabaseAuthClient } from '../supabase-auth-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(bodies: unknown[]) {
  const calls: Call[] = [];
  const queue = [...bodies];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = queue.shift() ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const TOKEN_BODY = {
  access_token: 'a.b.c',
  refresh_token: 'r-1',
  user: { id: '11111111-1111-4111-8111-111111111111' },
};

describe('readSupabaseEnv', () => {
  it('returns null when the keys are missing, so the build works with no env', () => {
    expect(readSupabaseEnv({})).toBeNull();
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: ENV.NEXT_PUBLIC_SUPABASE_URL })).toBeNull();
  });

  it('reads both keys and drops a trailing slash from the url', () => {
    expect(readSupabaseEnv({ ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/' }))
      .toEqual({ url: 'https://proj.supabase.test', anonKey: 'test-anon-key' });
  });
});

describe('createSupabaseAuthClient', () => {
  it('is created without touching the env (lazy), so importing it cannot crash the build', () => {
    expect(() => createSupabaseAuthClient({ env: {}, fetchImpl: fakeFetch([]).fn })).not.toThrow();
  });

  it('reports not-configured instead of calling out when the env is missing', async () => {
    const { fn, calls } = fakeFetch([]);
    const client = createSupabaseAuthClient({ env: {}, fetchImpl: fn });
    expect(client.isConfigured()).toBe(false);
    await expect(client.sendEmailCode('a@b.test')).rejects.toThrow(/not configured/i);
    expect(calls).toHaveLength(0);
  });

  it('posts the email to the Supabase otp endpoint', async () => {
    const { fn, calls } = fakeFetch([{}]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    await client.sendEmailCode('student@politypedia.test');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proj.supabase.test/auth/v1/otp');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      email: 'student@politypedia.test',
      create_user: true,
    });
    expect(new Headers(calls[0].init.headers).get('apikey')).toBe('test-anon-key');
  });

  // Issue 05-teacher-invite-approval: a teacher session also carries
  // `teachers.status`, read with a second RLS-checked call.
  it('verifies a code and returns the session with the profile role', async () => {
    const { fn, calls } = fakeFetch([TOKEN_BODY, [{ role: 'teacher' }], [{ status: 'approved' }]]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.verifyEmailCode('student@politypedia.test', '123456');

    expect(calls[0].url).toBe('https://proj.supabase.test/auth/v1/verify');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      email: 'student@politypedia.test',
      token: '123456',
      type: 'email',
    });
    expect(session).toEqual({
      accessToken: 'a.b.c',
      refreshToken: 'r-1',
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'teacher',
      teacherStatus: 'approved',
    });
    expect(calls[2].url).toBe('https://proj.supabase.test/rest/v1/teachers?select=status');
  });

  it('falls back to role student when the profile row is not readable yet', async () => {
    const { fn } = fakeFetch([TOKEN_BODY, []]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });
    const session = await client.verifyEmailCode('a@b.test', '123456');
    expect(session.role).toBe('student');
  });

  it('exchanges an oauth code for a session (pkce)', async () => {
    const { fn, calls } = fakeFetch([TOKEN_BODY, [{ role: 'student' }]]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.exchangeCodeForSession('auth-code-1', 'verifier-1');

    expect(calls[0].url).toBe('https://proj.supabase.test/auth/v1/token?grant_type=pkce');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      auth_code: 'auth-code-1',
      code_verifier: 'verifier-1',
    });
    expect(session.userId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('builds the Google authorize url with the callback and the pkce challenge', () => {
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fakeFetch([]).fn });

    const url = new URL(
      client.googleAuthorizeUrl('https://politypedia.test/auth/callback', 'challenge-1'),
    );

    expect(url.origin + url.pathname).toBe('https://proj.supabase.test/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('redirect_to')).toBe('https://politypedia.test/auth/callback');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  });

  it('never puts the code or a token in the error it throws', async () => {
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error_description: 'Token has expired', msg: 'bad 123456' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const error = await client.verifyEmailCode('a@b.test', '123456').catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('123456');
    expect((error as Error).message).not.toContain('a.b.c');
  });
});
