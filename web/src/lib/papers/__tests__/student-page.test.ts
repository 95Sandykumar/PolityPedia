/**
 * The student's past-papers read, now that a failure is visible
 * (issue 54a-read-error-core).
 *
 * Definition of done 3: "a failed read (HTTP error or thrown error) shows the
 * error state and never the empty-state text. A read that succeeds with zero
 * rows still shows the empty-state text."
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { readLivePapersResult } from '../student-page';
import type { AuthSession } from '@/lib/auth/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const PAPER = '33333333-3333-4333-8333-333333333333';
const EXAM = 'a4000001-0000-4000-8000-000000000001';

const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

const LIVE_PAPER = {
  id: PAPER,
  teacher_id: TEACHER,
  exam_id: EXAM,
  year: 2024,
  month: 6,
  label: 'Shift 1',
  pdf_questions_path: 'papers/q.pdf',
  pdf_solutions_path: null,
  status: 'live',
  archived_at: null,
};

function always(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

function read(fetchImpl: typeof fetch) {
  return readLivePapersResult(SESSION, TEACHER, { env: ENV, fetchImpl });
}

describe('readLivePapersResult', () => {
  it('a 200 with no rows is OK and empty, so the page keeps its empty state', async () => {
    const result = await read(always([]));

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 400 is a FAILED read, never an empty one', async () => {
    const result = await read(always({ message: 'bad request' }, 400));

    expect(result.ok).toBe(false);
  });

  it('a missing `archived_at` column is a failure, not "No papers yet"', async () => {
    const result = await read(
      always({ code: '42703', message: 'column papers.archived_at does not exist' }, 400),
    );

    expect(result.ok).toBe(false);
  });

  it('a request that throws is a FAILED read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await read(fetchImpl);

    expect(result.ok).toBe(false);
  });

  it('no session is OK and empty: signed out is not broken', async () => {
    const result = await readLivePapersResult(null, TEACHER, {
      env: ENV,
      fetchImpl: always([]),
    });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('returns the rows when the read answered 200', async () => {
    const result = await read(always([LIVE_PAPER]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe(PAPER);
    }
  });

  it('asks for the same rows as before: live papers of this teacher only', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response('[]', { status: 200 });
    };
    await readLivePapersResult(SESSION, TEACHER, { env: ENV, fetchImpl });

    const url = seen[0] ?? '';
    expect(url).toContain(`teacher_id=eq.${TEACHER}`);
    expect(url).toContain('status=eq.live');
    expect(url).not.toContain('select=*');
  });
});
