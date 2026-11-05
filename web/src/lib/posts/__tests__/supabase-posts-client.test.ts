/**
 * The server-side TeacherPostsClient over Supabase REST
 * (issue 09-teacher-notifications).
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object of dummy values. Every call carries the SIGNED-IN CALLER'S own
 * access token, so the `teacher_posts_*` policies in Postgres are the gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseTeacherPostsClient } from '../supabase-posts-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const ACCESS_TOKEN = 'caller.access.token';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const TEACHER_2 = '55555555-5555-4555-8555-555555555555';
const POST_ID = '99999999-9999-4999-8999-999999999999';

const ROW = {
  id: POST_ID,
  teacher_id: TEACHER,
  priority: 1,
  heading: 'NET form is out',
  link: 'https://ugcnet.nta.ac.in',
  created_at: '2026-11-05T10:00:00Z',
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
    const next = queue.shift() ?? { status: 200, body: null };
    return new Response(next.body === undefined || next.body === null ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined> = ENV,
  userId = TEACHER,
) {
  return createSupabaseTeacherPostsClient({ accessToken: ACCESS_TOKEN, userId, env, fetchImpl });
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

describe('listForTeacher', () => {
  it('orders by priority then date in the query, and carries the caller token', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);

    const posts = await client(fn).listForTeacher(TEACHER);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/teacher_posts');
    expect(calls[0].url).toContain('teacher_id=eq.' + TEACHER);
    expect(calls[0].url).toContain('order=priority.desc,created_at.desc');
    // Never select=*, so a column added later cannot leak by accident.
    expect(calls[0].url).not.toContain('select=*');
    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);

    expect(posts).toEqual([
      {
        id: POST_ID,
        teacherId: TEACHER,
        priority: 1,
        heading: 'NET form is out',
        link: 'https://ugcnet.nta.ac.in',
        createdAt: '2026-11-05T10:00:00Z',
      },
    ]);
  });

  it('returns an empty list for an id that is not a uuid, and asks nothing', async () => {
    const { fn, calls } = fakeFetch();
    expect(await client(fn).listForTeacher('../../rest/v1/teachers')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns an empty list when Supabase answers with an error', async () => {
    const { fn } = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
    expect(await client(fn).listForTeacher(TEACHER)).toEqual([]);
  });

  it('drops a row with no heading instead of showing a blank notice', async () => {
    const { fn } = fakeFetch([{ body: [{ ...ROW, heading: '' }, ROW] }]);
    const posts = await client(fn).listForTeacher(TEACHER);
    expect(posts).toHaveLength(1);
  });

  it('throws away a link that is not http or https', async () => {
    const { fn } = fakeFetch([{ body: [{ ...ROW, link: 'javascript:alert(1)' }] }]);
    const posts = await client(fn).listForTeacher(TEACHER);
    expect(posts[0].link).toBeNull();
  });

  it('reads an unknown priority as normal, so the row still shows', async () => {
    const { fn } = fakeFetch([{ body: [{ ...ROW, priority: 99 }] }]);
    const posts = await client(fn).listForTeacher(TEACHER);
    expect(posts[0].priority).toBe(0);
  });
});

describe('listForTeachers', () => {
  it('asks for several teachers in one request, newest and loudest first', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);

    const posts = await client(fn).listForTeachers([TEACHER, TEACHER_2], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`teacher_id=in.(${TEACHER},${TEACHER_2})`);
    expect(calls[0].url).toContain('order=priority.desc,created_at.desc');
    expect(calls[0].url).toContain('limit=5');
    expect(posts).toHaveLength(1);
  });

  it('asks nothing at all for an empty list of teachers', async () => {
    const { fn, calls } = fakeFetch();
    expect(await client(fn).listForTeachers([], 5)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('drops an id that is not a uuid before it reaches the URL', async () => {
    const { fn, calls } = fakeFetch([{ body: [] }]);
    await client(fn).listForTeachers([TEACHER, 'not-a-uuid'], 5);
    expect(calls[0].url).toContain(`teacher_id=in.(${TEACHER})`);
    expect(calls[0].url).not.toContain('not-a-uuid');
  });
});

describe('listMine', () => {
  it('filters on the callers own id, so the teacher page shows their posts', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);

    const posts = await client(fn).listMine();

    expect(calls[0].url).toContain('teacher_id=eq.' + TEACHER);
    expect(posts).toHaveLength(1);
  });
});

describe('create', () => {
  it('posts the row with the callers own id and hands the stored row back', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);

    const saved = await client(fn).create({
      heading: 'NET form is out',
      priority: 1,
      link: 'https://ugcnet.nta.ac.in',
    });

    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      teacher_id: TEACHER,
      heading: 'NET form is out',
      priority: 1,
      link: 'https://ugcnet.nta.ac.in',
    });
    // The stored row comes back, so the page shows the real id and date.
    expect(headers(calls[0]).prefer).toContain('return=representation');
    expect(saved.id).toBe(POST_ID);
    expect(saved.teacherId).toBe(TEACHER);
  });

  it('refuses to send a blank heading', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).create({ heading: '  ', priority: 0, link: null })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses to send a link with another scheme', async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      client(fn).create({ heading: 'Hi', priority: 0, link: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses to send a priority that is not one of ours', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).create({ heading: 'Hi', priority: 9, link: null })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('throws the status only, never the Supabase body', async () => {
    const { fn } = fakeFetch([
      { status: 403, body: { message: 'violates policy teacher_posts_insert_own' } },
    ]);

    await expect(
      client(fn).create({ heading: 'Hi', priority: 0, link: null }),
    ).rejects.toThrow(/status 403/);
    await expect(
      client(fn).create({ heading: 'Hi', priority: 0, link: null }),
    ).rejects.not.toThrow(/teacher_posts_insert_own/);
  });
});

describe('remove', () => {
  it('filters on the post id AND the callers own id', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);

    await client(fn).remove(POST_ID);

    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toContain('id=eq.' + POST_ID);
    // Belt and braces next to the policy: a delete can never reach past the
    // caller's own rows, even if a policy were loosened by mistake.
    expect(calls[0].url).toContain('teacher_id=eq.' + TEACHER);
  });

  it('refuses a post id that is not a uuid, and asks nothing', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).remove('nope')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('throws the status only when Supabase refuses', async () => {
    const { fn } = fakeFetch([{ status: 403, body: { message: 'teacher_posts_delete_own' } }]);
    await expect(client(fn).remove(POST_ID)).rejects.toThrow(/status 403/);
  });
});
