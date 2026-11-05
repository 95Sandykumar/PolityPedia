/**
 * The server-side FollowsClient over Supabase REST (issue 06-portfolio-follow).
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object of dummy values. Every call carries the SIGNED-IN STUDENT'S own
 * access token, so the `follows_*_own` policies in Postgres are the gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseFollowsClient } from '../supabase-follows-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const ACCESS_TOKEN = 'caller.access.token';
const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '44444444-4444-4444-8444-444444444444';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(replies: { status?: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift() ?? { status: 200, body: null };
    return new Response(next.body === null ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseFollowsClient({
    accessToken: ACCESS_TOKEN,
    userId: STUDENT,
    env,
    fetchImpl,
  });
}

function headers(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('isConfigured', () => {
  it('is false with no env, so a page can say "not set up" instead of crashing', () => {
    const { fn } = fakeFetch();
    expect(client(fn, {}).isConfigured()).toBe(false);
  });

  it('reads the env lazily: creating the client never touches the network', () => {
    const { fn, calls } = fakeFetch();
    client(fn, {});
    expect(calls).toHaveLength(0);
  });
});

describe('listFollowing', () => {
  it('asks only for teacher_id and carries the caller token', async () => {
    const { fn, calls } = fakeFetch([{ body: [{ teacher_id: TEACHER }] }]);

    const ids = await client(fn).listFollowing();

    expect(ids).toEqual([TEACHER]);
    expect(calls[0].url).toBe(
      'https://proj.supabase.test/rest/v1/follows?select=teacher_id&order=created_at.desc',
    );
    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);
    expect(headers(calls[0]).apikey).toBe('test-anon-key');
  });

  it('drops a row with no usable teacher_id', async () => {
    const { fn } = fakeFetch([
      { body: [{ teacher_id: TEACHER }, { teacher_id: null }, { teacher_id: 42 }, {}] },
    ]);
    expect(await client(fn).listFollowing()).toEqual([TEACHER]);
  });

  it('is an empty list, not a crash, when Supabase says no', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { message: 'bad token' } }]);
    expect(await client(fn).listFollowing()).toEqual([]);
  });

  it('is an empty list when the env is missing', async () => {
    const { fn, calls } = fakeFetch();
    expect(await client(fn, {}).listFollowing()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('follow', () => {
  it('posts the pair with the caller as user_id', async () => {
    const { fn, calls } = fakeFetch([{ status: 201 }]);

    await client(fn).follow(TEACHER);

    expect(calls[0].url).toBe('https://proj.supabase.test/rest/v1/follows');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      user_id: STUDENT,
      teacher_id: TEACHER,
    });
  });

  it('is idempotent: a double tap merges instead of conflicting', async () => {
    const { fn, calls } = fakeFetch([{ status: 201 }]);
    await client(fn).follow(TEACHER);
    expect(headers(calls[0]).prefer).toContain('resolution=merge-duplicates');
  });

  it('refuses a teacher id that is not a uuid, before any network call', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).follow('not-a-uuid')).rejects.toThrow(/uuid/);
    expect(calls).toHaveLength(0);
  });

  it('throws the status only, never the Supabase body', async () => {
    const { fn } = fakeFetch([
      { status: 403, body: { message: 'new row violates policy follows_insert_own' } },
    ]);
    await expect(client(fn).follow(TEACHER)).rejects.toThrow(
      'Supabase follow failed with status 403',
    );
  });
});

describe('unfollow', () => {
  it('deletes exactly the caller\'s own pair', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);

    await client(fn).unfollow(TEACHER);

    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe(
      `https://proj.supabase.test/rest/v1/follows?user_id=eq.${STUDENT}&teacher_id=eq.${TEACHER}`,
    );
  });

  it('refuses a teacher id that is not a uuid, before any network call', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).unfollow('../../rest/v1/profiles')).rejects.toThrow(/uuid/);
    expect(calls).toHaveLength(0);
  });

  it('throws the status only when Supabase says no', async () => {
    const { fn } = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
    await expect(client(fn).unfollow(TEACHER)).rejects.toThrow(
      'Supabase unfollow failed with status 500',
    );
  });
});
