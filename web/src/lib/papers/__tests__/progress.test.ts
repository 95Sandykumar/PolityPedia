/**
 * The papers-list progress read (issues 66-papers-question-count and
 * 81-fix-papers-count-truncation).
 *
 * Two requests for the whole list, never one per row (design check B8):
 * `paper_question_counts`, one row per paper, and the student's attempts.
 *
 * The count comes from the DATABASE. Counting question rows in JavaScript lost
 * papers once the list passed the 1000-row response cap, and a lost paper
 * showed "0 questions" and hid Practice (issue 81).
 *
 * `fetch` and the env bag are injected, so no network call and no real key
 * (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { readPaperProgress } from '../progress';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '55555555-5555-4555-8555-555555555555';
const PAPER_NONE = '10000000-0000-4000-8000-000000000001';
const PAPER_ONE = '10000000-0000-4000-8000-000000000002';
const PAPER_MANY = '10000000-0000-4000-8000-000000000003';

const SESSION = {
  accessToken: 'student-token',
  userId: STUDENT,
} as unknown as AuthSession;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers the count request and the attempts request by their path. */
function fakeFetch(countRows: unknown[], attemptRows: unknown[]) {
  return vi.fn(async (url: string | URL) => {
    const path = String(url);
    if (path.includes('/rest/v1/paper_question_counts')) return json(countRows);
    if (path.includes('/rest/v1/attempts')) return json(attemptRows);
    return json([]);
  });
}

describe('readPaperProgress', () => {
  it('takes each count from the database and ticks the paper with a submitted attempt', async () => {
    const fetchImpl = fakeFetch(
      [
        { paper_id: PAPER_ONE, question_count: 1 },
        { paper_id: PAPER_MANY, question_count: 3 },
      ],
      [{ paper_id: PAPER_ONE }],
    );

    const progress = await readPaperProgress(
      SESSION,
      [PAPER_NONE, PAPER_ONE, PAPER_MANY],
      { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(progress.get(PAPER_NONE)).toEqual({ questionCount: 0, done: false });
    expect(progress.get(PAPER_ONE)).toEqual({ questionCount: 1, done: true });
    expect(progress.get(PAPER_MANY)).toEqual({ questionCount: 3, done: false });
  });

  it('keeps a 200-question paper at 200 from a single row, so no cap can truncate it', async () => {
    // Ten full papers: 2000 question rows, which no PostgREST page would hold.
    const ids = Array.from(
      { length: 10 },
      (_unused, i) => `10000000-0000-4000-8000-00000000001${i}`,
    );
    const fetchImpl = fakeFetch(
      ids.map((id) => ({ paper_id: id, question_count: 200 })),
      [],
    );

    const progress = await readPaperProgress(SESSION, ids, {
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const id of ids) {
      expect(progress.get(id)).toEqual({ questionCount: 200, done: false });
    }
  });

  it('makes one count query and one attempt query for the whole list', async () => {
    const fetchImpl = fakeFetch([], []);

    await readPaperProgress(SESSION, [PAPER_NONE, PAPER_ONE, PAPER_MANY], {
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    // No request for raw question rows: that is what used to get truncated.
    expect(urls.some((u) => u.includes('/rest/v1/questions'))).toBe(false);
    const countUrl = urls.find((u) => u.includes('/rest/v1/paper_question_counts')) ?? '';
    expect(countUrl).toContain('select=paper_id,question_count');
    expect(countUrl).toContain(`paper_id=in.(${PAPER_NONE},${PAPER_ONE},${PAPER_MANY})`);
    const attemptUrl = urls.find((u) => u.includes('/rest/v1/attempts')) ?? '';
    expect(attemptUrl).toContain(`user_id=eq.${STUDENT}`);
    expect(attemptUrl).toContain('submitted_at=not.is.null');
  });

  it('returns nothing and fires no request with no session or no papers', async () => {
    const fetchImpl = fakeFetch([], []);
    const fetchFn = fetchImpl as unknown as typeof fetch;

    expect((await readPaperProgress(null, [PAPER_ONE], { env: ENV, fetchImpl: fetchFn })).size).toBe(0);
    expect((await readPaperProgress(SESSION, [], { env: ENV, fetchImpl: fetchFn })).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves the count unknown when the count query fails, so Practice is never hidden by an outage', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/rest/v1/paper_question_counts')) {
        return new Response('boom', { status: 500 });
      }
      return json([{ paper_id: PAPER_ONE }]);
    });

    const progress = await readPaperProgress(SESSION, [PAPER_ONE], {
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(progress.has(PAPER_ONE)).toBe(false);
  });

  it('reads a count that arrives as a numeric string, so a big count never falls back to zero', async () => {
    const fetchImpl = fakeFetch([{ paper_id: PAPER_MANY, question_count: '200' }], []);

    const progress = await readPaperProgress(SESSION, [PAPER_MANY], {
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(progress.get(PAPER_MANY)).toEqual({ questionCount: 200, done: false });
  });
});
