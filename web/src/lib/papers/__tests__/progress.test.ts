/**
 * The papers-list progress read (issue 66-papers-question-count).
 *
 * One question count query and one attempt query for the whole list, never
 * one per row (design check B8). `fetch` and the env bag are injected, so no
 * network call and no real key (web/CLAUDE.md).
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

/** Answers the questions request and the attempts request by their path. */
function fakeFetch(questionRows: unknown[], attemptRows: unknown[]) {
  return vi.fn(async (url: string | URL) => {
    const path = String(url);
    if (path.includes('/rest/v1/questions')) return json(questionRows);
    if (path.includes('/rest/v1/attempts')) return json(attemptRows);
    return json([]);
  });
}

describe('readPaperProgress', () => {
  it('counts live questions per paper and ticks the paper with a submitted attempt', async () => {
    const fetchImpl = fakeFetch(
      [
        { paper_id: PAPER_ONE },
        { paper_id: PAPER_MANY },
        { paper_id: PAPER_MANY },
        { paper_id: PAPER_MANY },
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

  it('makes one question query and one attempt query for the whole list', async () => {
    const fetchImpl = fakeFetch([], []);

    await readPaperProgress(SESSION, [PAPER_NONE, PAPER_ONE, PAPER_MANY], {
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    const questionUrl = urls.find((u) => u.includes('/rest/v1/questions')) ?? '';
    expect(questionUrl).toContain('status=eq.live');
    expect(questionUrl).toContain(`paper_id=in.(${PAPER_NONE},${PAPER_ONE},${PAPER_MANY})`);
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

  it('leaves the count unknown when the question query fails, so Practice is never hidden by an outage', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/rest/v1/questions')) {
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
});
