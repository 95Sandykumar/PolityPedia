/**
 * The student videos read, now that a failure is visible
 * (issue 54c-read-errors-saved-practice-media).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * TWO reads sit behind this page: the teacher, from the `teachers_public`
 * view, and their videos. EITHER one failing is a failed read, because a
 * teacher with no videos and a teacher whose videos could not be read look
 * identical on the screen.
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { readStudentVideos, readStudentVideosResult } from '../page-data';
import type { AuthSession } from '@/lib/auth/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

const TEACHER_ROW = {
  user_id: TEACHER,
  identity_mode: 'alias',
  display_name: 'Polity Guru',
  avatar_path: null,
  bio_en: null,
  bio_hi: null,
  videos_visible: true,
};

const VIDEO_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  teacher_id: TEACHER,
  youtube_id: 'dQw4w9WgXcQ',
  title: 'Preamble in 10 minutes',
  position: 1,
};

/** A fetch that answers the teacher view and the videos table apart. */
function routed(
  teacher: { body: unknown; status?: number },
  videos: { body: unknown; status?: number },
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const pick = url.includes('teachers_public') ? teacher : videos;
    return new Response(JSON.stringify(pick.body), { status: pick.status ?? 200 });
  }) as unknown as typeof fetch;
}

function read(fetchImpl: typeof fetch) {
  return readStudentVideosResult(SESSION, TEACHER, { env: ENV, fetchImpl });
}

describe('readStudentVideosResult', () => {
  it('a 200 with no videos is OK and empty, so the page keeps its empty state', async () => {
    const result = await read(routed({ body: [TEACHER_ROW] }, { body: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok read');
    expect(result.data.teacher?.userId).toBe(TEACHER);
    expect(result.data.videos).toEqual([]);
  });

  it('a 200 with videos is OK and carries them', async () => {
    const result = await read(routed({ body: [TEACHER_ROW] }, { body: [VIDEO_ROW] }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok read');
    expect(result.data.videos).toHaveLength(1);
  });

  it('no such teacher is an OK read with no teacher, not a failure', async () => {
    const result = await read(routed({ body: [] }, { body: [] }));

    expect(result).toEqual({ ok: true, data: { teacher: null, videos: [] } });
  });

  it('a 400 on the TEACHER read is a FAILED read', async () => {
    const result = await read(
      routed({ body: { message: 'bad request' }, status: 400 }, { body: [] }),
    );

    expect(result).toEqual({ ok: false });
  });

  it('a 400 on the VIDEOS read is a FAILED read, never an empty list', async () => {
    const result = await read(
      routed({ body: [TEACHER_ROW] }, { body: { message: 'bad request' }, status: 400 }),
    );

    expect(result).toEqual({ ok: false });
  });

  it('a 500 on the videos read is a FAILED read', async () => {
    const result = await read(
      routed({ body: [TEACHER_ROW] }, { body: { message: 'boom' }, status: 500 }),
    );

    expect(result).toEqual({ ok: false });
  });

  it('a thrown request is a FAILED read', async () => {
    const thrower = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(await read(thrower)).toEqual({ ok: false });
  });

  it('signed out still reads the public teacher, and is not a failure', async () => {
    const result = await readStudentVideosResult(null, TEACHER, {
      env: ENV,
      fetchImpl: routed({ body: [TEACHER_ROW] }, { body: [] }),
    });

    expect(result.ok).toBe(true);
  });

  it('names no table, column, key or status anywhere in the answer', async () => {
    const result = await read(
      routed(
        { body: [TEACHER_ROW] },
        { body: { message: 'column teacher_videos.position does not exist' }, status: 400 },
      ),
    );

    expect(JSON.stringify(result)).toBe(JSON.stringify({ ok: false }));
  });
});

describe('readStudentVideos, the plain flavour', () => {
  it('still hands back the teacher and videos on a read that worked', async () => {
    const data = await readStudentVideos(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: routed({ body: [TEACHER_ROW] }, { body: [VIDEO_ROW] }),
    });

    expect(data.teacher?.displayName).toBe('Polity Guru');
    expect(data.videos).toHaveLength(1);
  });

  it('hands back nothing on a failure, for callers with no error state', async () => {
    const data = await readStudentVideos(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: routed({ body: [TEACHER_ROW] }, { body: {}, status: 400 }),
    });

    expect(data).toEqual({ teacher: null, videos: [] });
  });
});
