/**
 * The server-side VideosClient over Supabase REST (issue 08-videos-tile).
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object of dummy values. Every call carries the SIGNED-IN USER'S own
 * access token, so the `teacher_videos_*` policies in `0008_videos.sql` are
 * the gate, not this file.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseVideosClient } from '../supabase-videos-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const ACCESS_TOKEN = 'caller.access.token';
const TEACHER = '11111111-1111-4111-8111-111111111111';
const VIDEO = '22222222-2222-4222-8222-222222222222';
const YT = 'dQw4w9WgXcQ';

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
  return createSupabaseVideosClient({
    accessToken: ACCESS_TOKEN,
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

function headers(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

const ROW = {
  id: VIDEO,
  teacher_id: TEACHER,
  youtube_id: YT,
  title: 'Indian Constitution in 10 minutes',
  thumb_url: `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
  position: 0,
};

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
  it('filters on the teacher, orders by position and carries the caller token', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);

    const videos = await client(fn).listForTeacher(TEACHER);

    expect(videos).toEqual([
      {
        id: VIDEO,
        teacherId: TEACHER,
        youtubeId: YT,
        title: 'Indian Constitution in 10 minutes',
        thumbUrl: `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
        position: 0,
      },
    ]);
    expect(calls[0].url).toContain('/rest/v1/teacher_videos');
    expect(calls[0].url).toContain('teacher_id=eq.' + TEACHER);
    expect(calls[0].url).toContain('order=position.asc');
    // Never select=*, so a column added later cannot leak by accident.
    expect(calls[0].url).not.toContain('select=*');
    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);
  });

  it('returns an empty list for an id that is not a uuid, with no request', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).listForTeacher('../../evil')).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns an empty list when Supabase answers with an error', async () => {
    const { fn } = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
    await expect(client(fn).listForTeacher(TEACHER)).resolves.toEqual([]);
  });

  it('drops a row whose youtube_id is not a YouTube id', async () => {
    const { fn } = fakeFetch([
      { body: [{ ...ROW, youtube_id: '../../evil' }, { ...ROW, id: null }] },
    ]);
    await expect(client(fn).listForTeacher(TEACHER)).resolves.toEqual([]);
  });
});

describe('listMine', () => {
  it('asks for the caller own rows', async () => {
    const { fn, calls } = fakeFetch([{ body: [ROW] }]);

    const mine = await client(fn).listMine();

    expect(mine).toHaveLength(1);
    expect(calls[0].url).toContain('teacher_id=eq.' + TEACHER);
  });
});

describe('add', () => {
  it('posts the row with the caller own id as the owner', async () => {
    const { fn, calls } = fakeFetch([{ status: 201 }]);

    await client(fn).add({
      youtubeId: YT,
      title: 'Polity',
      thumbUrl: `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
      position: 2,
    });

    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      teacher_id: TEACHER,
      youtube_id: YT,
      title: 'Polity',
      thumb_url: `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
      position: 2,
    });
  });

  it('throws the status only, never the Supabase body', async () => {
    const { fn } = fakeFetch([
      { status: 403, body: { message: 'row-level security policy teacher_videos_insert_own' } },
    ]);

    const thrown = await client(fn)
      .add({ youtubeId: YT, title: null, thumbUrl: 'x', position: 0 })
      .then(() => null)
      .catch((error: Error) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('403');
    // The policy name is in the body we just refused to read.
    expect((thrown as Error).message).not.toContain('row-level security');
  });

  it('refuses an id that is not a YouTube id before any request', async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      client(fn).add({ youtubeId: '../../evil', title: null, thumbUrl: 'x', position: 0 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('remove', () => {
  it('deletes by row id and by the caller own id', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);

    await client(fn).remove(VIDEO);

    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toContain('id=eq.' + VIDEO);
    // The owner is in the filter as well as the policy: belt and braces.
    expect(calls[0].url).toContain('teacher_id=eq.' + TEACHER);
  });

  it('refuses a row id that is not a uuid', async () => {
    const { fn, calls } = fakeFetch();
    await expect(client(fn).remove('not-a-uuid')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('Show / No show', () => {
  it('reads videos_visible off the caller own teachers row', async () => {
    const { fn, calls } = fakeFetch([{ body: [{ videos_visible: false }] }]);

    await expect(client(fn).readVisible()).resolves.toBe(false);
    expect(calls[0].url).toContain('/rest/v1/teachers');
    expect(calls[0].url).toContain('select=videos_visible');
  });

  it('reads true when there is no row to read, matching the column default', async () => {
    const { fn } = fakeFetch([{ body: [] }]);
    await expect(client(fn).readVisible()).resolves.toBe(true);
  });

  it('patches videos_visible on the caller own row only', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);

    await client(fn).setVisible(false);

    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].url).toContain('user_id=eq.' + TEACHER);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ videos_visible: false });
  });

  it('throws the status only when the patch is refused', async () => {
    const { fn } = fakeFetch([{ status: 403, body: { message: 'teachers_update_own' } }]);
    await expect(client(fn).setVisible(true)).rejects.toThrow(/403/);
  });
});
