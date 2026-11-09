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

// Issue 33-session-refresh: renew and revoke.
describe('refreshSession and signOut', () => {
  it('swaps the refresh token for a new session and records the expiry', async () => {
    const { fn, calls } = fakeFetch([
      { ...TOKEN_BODY, access_token: 'a2.b2.c2', refresh_token: 'r-2', expires_at: 1_800_003_600 },
      [{ role: 'student' }],
    ]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1');

    expect(calls[0].url).toBe('https://proj.supabase.test/auth/v1/token?grant_type=refresh_token');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refresh_token: 'r-1' });
    expect(session.accessToken).toBe('a2.b2.c2');
    expect(session.refreshToken).toBe('r-2');
    expect(session.expiresAt).toBe(1_800_003_600);
  });

  it('turns expires_in into a clock time, so the cookie can be checked later', async () => {
    const { fn } = fakeFetch([{ ...TOKEN_BODY, expires_in: 3600 }, [{ role: 'student' }]]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const before = Math.floor(Date.now() / 1000);
    const session = await client.refreshSession('r-1');

    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(session.expiresAt).toBeLessThanOrEqual(before + 3601);
  });

  it('revokes the session with the user own token, not the anon key', async () => {
    const { fn, calls } = fakeFetch([{}]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    await client.signOut('a.b.c');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proj.supabase.test/auth/v1/logout?scope=local');
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('authorization')).toBe('Bearer a.b.c');
    expect(headers.get('apikey')).toBe('test-anon-key');
  });
});

/**
 * Issue 39-profile-read-keeps-role: a failed profile read must not downgrade a
 * signed-in user.
 *
 * `toSession` reads `profiles.role` after EVERY token response, including a
 * refresh. When that read answered 500, 429 or 401 the old code returned
 * `student`, the caller wrote it into the cookie, and an admin was a student
 * for the 7 days the cookie lives. A thrown `fetch` was worse: the whole
 * refresh threw, so the NEW tokens were dropped although Supabase had already
 * spent the old refresh token.
 */
type ProfileStep = { body: unknown } | { status: number } | { throws: unknown };

function stepFetch(steps: ProfileStep[]) {
  const calls: Call[] = [];
  const queue = [...steps];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const step = queue.shift() ?? { body: {} };
    if ('throws' in step) throw step.throws;
    const status = 'status' in step ? step.status : 200;
    const body = 'status' in step ? { message: 'no' } : step.body;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('a refresh keeps the role the user already had', () => {
  for (const status of [500, 429, 401]) {
    it(`keeps admin when the profile read answers ${status}`, async () => {
      const { fn } = stepFetch([{ body: TOKEN_BODY }, { status }]);
      const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

      const session = await client.refreshSession('r-1', { role: 'admin' });

      expect(session.role).toBe('admin');
      expect(session.accessToken).toBe('a.b.c');
      expect(session.teacherStatus).toBeUndefined();
    });
  }

  it('keeps admin AND the new tokens when the profile read throws', async () => {
    const { fn } = stepFetch([
      { body: { ...TOKEN_BODY, access_token: 'a2.b2.c2', refresh_token: 'r-2' } },
      { throws: new TypeError('fetch failed') },
    ]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1', { role: 'admin' });

    // Supabase already rotated the refresh token, so losing this would lock
    // the user out even though nothing was wrong with their session.
    expect(session).toEqual({
      accessToken: 'a2.b2.c2',
      refreshToken: 'r-2',
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'admin',
    });
  });

  it('takes the NEW role when the profile read answers ok, so a demotion lands', async () => {
    const { fn } = stepFetch([{ body: TOKEN_BODY }, { body: [{ role: 'student' }] }]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1', { role: 'admin' });

    expect(session.role).toBe('student');
    expect(session.teacherStatus).toBeUndefined();
  });

  it('keeps an approved teacher approved when the teacher-status read fails', async () => {
    const { fn, calls } = stepFetch([
      { body: TOKEN_BODY },
      { body: [{ role: 'teacher' }] },
      { status: 503 },
    ]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1', {
      role: 'teacher',
      teacherStatus: 'approved',
    });

    expect(session.role).toBe('teacher');
    expect(session.teacherStatus).toBe('approved');
    expect(calls[2].url).toBe('https://proj.supabase.test/rest/v1/teachers?select=status');
  });

  it('keeps an approved teacher approved when BOTH reads fail', async () => {
    const { fn } = stepFetch([{ body: TOKEN_BODY }, { status: 500 }, { throws: new Error('x') }]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1', {
      role: 'teacher',
      teacherStatus: 'approved',
    });

    expect(session.role).toBe('teacher');
    expect(session.teacherStatus).toBe('approved');
  });

  it('takes a NEW teacher status when the read answers ok, so a suspension lands', async () => {
    const { fn } = stepFetch([
      { body: TOKEN_BODY },
      { body: [{ role: 'teacher' }] },
      { body: [{ status: 'pending' }] },
    ]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1', {
      role: 'teacher',
      teacherStatus: 'approved',
    });

    expect(session.teacherStatus).toBe('pending');
  });
});

describe('a first sign-in still fails closed, because there is no previous role', () => {
  it('gives student when the profile read fails on an email code', async () => {
    const { fn } = stepFetch([{ body: TOKEN_BODY }, { status: 500 }]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.verifyEmailCode('a@b.test', '123456');

    expect(session.role).toBe('student');
  });

  it('gives student when the profile read throws on a code exchange', async () => {
    const { fn } = stepFetch([{ body: TOKEN_BODY }, { throws: new TypeError('fetch failed') }]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.exchangeCodeForSession('auth-code-1', 'verifier-1');

    expect(session.role).toBe('student');
  });

  it('gives a teacher pending when the teacher-status read fails', async () => {
    const { fn } = stepFetch([
      { body: TOKEN_BODY },
      { body: [{ role: 'teacher' }] },
      { status: 500 },
    ]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.verifyEmailCode('a@b.test', '123456');

    expect(session.role).toBe('teacher');
    expect(session.teacherStatus).toBe('pending');
  });

  it('gives student when a refresh has no previous role either', async () => {
    const { fn } = stepFetch([{ body: TOKEN_BODY }, { status: 500 }]);
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });

    const session = await client.refreshSession('r-1');

    expect(session.role).toBe('student');
  });
});

describe('verifyEmailCode failures (issue 64-signin-errors-and-resend)', () => {
  it('keeps the status and the error_code on the thrown error, never the message', async () => {
    const fn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error_code: 'otp_expired', msg: 'token 424242 expired' }),
          { status: 403 },
        ),
    ) as unknown as typeof fetch;
    const client = createSupabaseAuthClient({ env: ENV, fetchImpl: fn });
    const error = (await client.verifyEmailCode('a@b.test', '424242').catch((e: unknown) => e)) as {
      status: number;
      code?: string;
      message: string;
    };
    expect(error.status).toBe(403);
    expect(error.code).toBe('otp_expired');
    expect(error.message).not.toContain('424242');
  });
});
