/**
 * The student's mock-list read, now that a failure is visible
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
import { readMockList, readMockListResult } from '../student-page';
import type { AuthSession } from '@/lib/auth/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const EXAM = 'a4000001-0000-4000-8000-000000000001';

const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

const LIVE_SET = {
  id: SET,
  teacher_id: TEACHER,
  exam_id: EXAM,
  title: 'UGC NET Paper 1 set',
  price_inr: 299,
  status: 'live',
  archived_at: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that answers every call the same way. */
function always(body: unknown, status = 200) {
  return vi.fn(async () => json(body, status)) as unknown as typeof fetch;
}

function read(fetchImpl: typeof fetch) {
  return readMockListResult(SESSION, TEACHER, { env: ENV, fetchImpl });
}

describe('readMockListResult', () => {
  it('a 200 with no rows is OK and empty, so the page keeps its empty state', async () => {
    const result = await read(always([]));

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 400 is a FAILED read, never an empty one', async () => {
    const result = await read(always({ message: 'bad request' }, 400));

    expect(result.ok).toBe(false);
  });

  it('the original bug: a missing `archived_at` column is a failure, not "no mock tests yet"', async () => {
    // Exactly what PostgREST answered when the column was not there. The old
    // reader turned this into `[]` and the student was told the teacher had
    // not uploaded anything.
    const result = await read(
      always(
        {
          code: '42703',
          message: 'column mock_sets.archived_at does not exist',
        },
        400,
      ),
    );

    expect(result.ok).toBe(false);
  });

  it('a failure on a LATER read of the chain still fails the whole read', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // 1: the live sets. 2 onwards: that set's tests, my access, my scores.
      if (call === 1) return json([LIVE_SET]);
      return json({ message: 'bad request' }, 400);
    }) as unknown as typeof fetch;

    const result = await read(fetchImpl);

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
    const result = await readMockListResult(null, TEACHER, {
      env: ENV,
      fetchImpl: always([]),
    });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('returns the rows when every read answered 200', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return json([LIVE_SET]);
      return json([]);
    }) as unknown as typeof fetch;

    const result = await read(fetchImpl);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe(SET);
    }
  });
});

describe('readMockList', () => {
  it('still gives a plain list, so the other screens are untouched', async () => {
    await expect(
      readMockList(SESSION, TEACHER, { env: ENV, fetchImpl: always([]) }),
    ).resolves.toEqual([]);
  });

  it('gives an empty list on a failure, the old fail-soft behaviour', async () => {
    await expect(
      readMockList(SESSION, TEACHER, {
        env: ENV,
        fetchImpl: always({ message: 'bad request' }, 400),
      }),
    ).resolves.toEqual([]);
  });
});
