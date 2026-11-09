/**
 * The public teacher read, for an ANONYMOUS caller (issue 63-public-landing).
 *
 * A shared `/t/<id>` link has no session cookie, so there is no user access
 * token to send. 0005 already grants `select on public.teachers_public to
 * anon`, so the read is possible with the project anon key as the bearer and
 * NO migration is needed.
 *
 * Design constraint C is what these tests guard:
 *  - the request goes to the VIEW `teachers_public`, never the table, and asks
 *    for named public columns only, so a real name cannot come back.
 *  - no user token is sent, so nothing signed-in can be read by accident.
 *  - `cache: 'no-store'`, so no response is kept for the next visitor.
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object of dummy values (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { readPublicTeacher } from '../public-teacher';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const TEACHER = '44444444-4444-4444-8444-444444444444';

const ROW = {
  user_id: TEACHER,
  identity_mode: 'alias',
  display_name: 'Polity Guru',
  avatar_path: 'avatars/owl.png',
  bio_en: 'Teaches polity',
  bio_hi: 'राजनीति पढ़ाते हैं',
  videos_visible: true,
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(replies: { status?: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift() ?? { status: 200, body: [] };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function headers(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('readPublicTeacher', () => {
  it('reads the view, never the teachers table', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);
    await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/teachers_public');
    expect(calls[0].url).not.toContain('/rest/v1/teachers?');
  });

  it('asks for the public columns by name, so a new column cannot leak', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);
    await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn });

    expect(calls[0].url).not.toContain('select=*');
    expect(calls[0].url).not.toContain('real_name');
    expect(calls[0].url).toContain('display_name');
  });

  it('sends the anon key as the bearer: there is no signed-in token to send', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);
    await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn });

    expect(headers(calls[0]).authorization).toBe('Bearer test-anon-key');
    expect(headers(calls[0]).apikey).toBe('test-anon-key');
  });

  it('never caches the answer, so one visitor cannot be served another read', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);
    await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn });
    expect(calls[0].init.cache).toBe('no-store');
  });

  it('maps the row to the public fields only', async () => {
    const { fn } = fakeFetch([{ body: [ROW] }]);
    const teacher = await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn });

    expect(teacher).toEqual({
      userId: TEACHER,
      identityMode: 'alias',
      displayName: 'Polity Guru',
      avatarPath: 'avatars/owl.png',
      bioEn: 'Teaches polity',
      bioHi: 'राजनीति पढ़ाते हैं',
      videosVisible: true,
    });
    expect(Object.keys(teacher ?? {})).not.toContain('realName');
  });

  it('is null for an id that is not a uuid, with no request at all', async () => {
    const { fn, calls } = fakeFetch();
    expect(await readPublicTeacher('../../teachers', { env: ENV, fetchImpl: fn })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null when Supabase is not set up, and asks nothing', async () => {
    const { fn, calls } = fakeFetch();
    expect(await readPublicTeacher(TEACHER, { env: {}, fetchImpl: fn })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null when the read fails, so the page shows the sign-in pitch instead', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { message: 'no' } }]);
    expect(await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn })).toBeNull();
  });

  it('is null when fetch itself throws, never a 500 on a shared link', async () => {
    const fn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await readPublicTeacher(TEACHER, { env: ENV, fetchImpl: fn })).toBeNull();
  });
});
