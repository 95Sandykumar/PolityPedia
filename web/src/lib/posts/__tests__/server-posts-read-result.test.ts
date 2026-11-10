/**
 * The notice reads, now that a failure is visible
 * (issue 54b-read-errors-home-teachers).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * Home used to say "No notices yet" whether the teachers it follows had
 * written nothing or the read had broken. The two are now different answers.
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { readHomePostsResult, readTeacherPostsResult } from '../server-posts';
import type { AuthSession } from '@/lib/auth/types';
import type { PublicTeacher } from '@/lib/teachers/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const POST = '66666666-6666-4666-8666-666666666666';

const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

const FOLLOWED: PublicTeacher[] = [
  {
    userId: TEACHER,
    identityMode: 'alias',
    displayName: 'Polity Guru',
    avatarPath: null,
    bioEn: null,
    bioHi: null,
    videosVisible: true,
  },
];

const POST_ROW = {
  id: POST,
  teacher_id: TEACHER,
  priority: 0,
  heading: 'Class moved to Monday',
  link: null,
  created_at: '2026-11-08T10:00:00.000Z',
};

function always(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('readHomePostsResult (Home notices)', () => {
  it('a 200 with no notices is OK and empty, so Home keeps its empty state', async () => {
    const result = await readHomePostsResult(SESSION, FOLLOWED, {
      env: ENV,
      fetchImpl: always([]),
    });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 400 is a FAILED read, never an empty one', async () => {
    const result = await readHomePostsResult(SESSION, FOLLOWED, {
      env: ENV,
      fetchImpl: always({ message: 'bad request' }, 400),
    });

    expect(result.ok).toBe(false);
  });

  it('a request that throws is a FAILED read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await readHomePostsResult(SESSION, FOLLOWED, { env: ENV, fetchImpl });

    expect(result.ok).toBe(false);
  });

  it('following nobody is OK and empty, and sends no request at all', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const result = await readHomePostsResult(SESSION, [], { env: ENV, fetchImpl });

    expect(result).toEqual({ ok: true, data: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the notices, with the author name, when the read answered 200', async () => {
    const result = await readHomePostsResult(SESSION, FOLLOWED, {
      env: ENV,
      fetchImpl: always([POST_ROW]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.teacherName).toBe('Polity Guru');
    }
  });

  it('asks for the same rows as before: followed teachers only, capped', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response('[]', { status: 200 });
    };
    await readHomePostsResult(SESSION, FOLLOWED, { env: ENV, fetchImpl });

    const url = seen[0] ?? '';
    expect(url).toContain(`teacher_id=in.(${TEACHER})`);
    expect(url).toContain('limit=5');
    expect(url).not.toContain('select=*');
  });
});

describe('readTeacherPostsResult (one teacher, for the tile count)', () => {
  it('a 200 with no notices is OK and empty', async () => {
    const result = await readTeacherPostsResult(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: always([]),
    });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 400 is a FAILED read, so the tile shows no number rather than 0', async () => {
    const result = await readTeacherPostsResult(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: always({ message: 'bad request' }, 400),
    });

    expect(result.ok).toBe(false);
  });

  it('returns the rows when the read answered 200', async () => {
    const result = await readTeacherPostsResult(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: always([POST_ROW]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]?.id).toBe(POST);
  });
});
