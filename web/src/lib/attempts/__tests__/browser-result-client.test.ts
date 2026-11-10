/**
 * The browser's read of a result (issue 56-result-page).
 *
 * What it has to prove:
 *
 *  * The attempt id rides in the PATH and nothing else is sent. Ownership is
 *    decided by `attempts_select_own` (0013) over the session token.
 *  * One 401 is a refresh and ONE retry, never a loop: the read that follows
 *    the final submit of a 360-minute mock is the one most likely to meet a
 *    token that died of age.
 *  * It FAILS SOFT. A refusal, a broken body or a dead network is null, not a
 *    throw: the score the submit handed back is already on screen.
 *
 * `fetch` is injected: no network call anywhere here.
 */
import { describe, expect, it, vi } from 'vitest';
import { REFRESH_PATH } from '@/lib/auth/browser-auth-client';
import { createBrowserResultReader } from '../browser-result-client';
import { attemptResultPath, type AttemptResult } from '../types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';

const RESULT: AttemptResult = {
  attemptId: ATTEMPT,
  mode: 'exam',
  score: 24,
  total: 20,
  percent: 40,
  right: 8,
  wrong: 2,
  skipped: 10,
  timeTakenSec: 3600,
  autoSubmitted: true,
  wrongQuestions: [],
};

/** A fetch that answers with the given replies, in order. */
function fakeFetch(replies: { status: number; body?: unknown }[]) {
  const paths: string[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (path: string | URL) => {
    paths.push(String(path));
    const next = queue.shift() ?? { status: 200, body: { result: null } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, paths };
}

describe('createBrowserResultReader', () => {
  it('reads the result in one call while the token is alive', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { result: RESULT } }]);

    const got = await createBrowserResultReader(fetchImpl.fn)(ATTEMPT);

    expect(got).toEqual(RESULT);
    expect(fetchImpl.paths).toEqual([attemptResultPath(ATTEMPT)]);
  });

  it('refreshes once after a 401 and reads again', async () => {
    const fetchImpl = fakeFetch([
      { status: 401 },
      { status: 200, body: { ok: true } },
      { status: 200, body: { result: RESULT } },
    ]);

    const got = await createBrowserResultReader(fetchImpl.fn)(ATTEMPT);

    expect(got).toEqual(RESULT);
    expect(fetchImpl.paths).toEqual([
      attemptResultPath(ATTEMPT),
      REFRESH_PATH,
      attemptResultPath(ATTEMPT),
    ]);
  });

  it('gives up after one retry rather than looping on a signed-out student', async () => {
    const fetchImpl = fakeFetch([
      { status: 401 },
      { status: 200, body: { ok: true } },
      { status: 401 },
    ]);

    expect(await createBrowserResultReader(fetchImpl.fn)(ATTEMPT)).toBeNull();
    expect(fetchImpl.paths).toHaveLength(3);
  });

  it('is null for a sitting with nothing to show, and does not throw', async () => {
    // One shape for an open sitting, a missing id and another student's row.
    const fetchImpl = fakeFetch([{ status: 200, body: { result: null } }]);
    expect(await createBrowserResultReader(fetchImpl.fn)(ATTEMPT)).toBeNull();
  });

  it('is null for a refusal, a body that is not a result, and a dead network', async () => {
    const refused = fakeFetch([{ status: 500 }]);
    expect(await createBrowserResultReader(refused.fn)(ATTEMPT)).toBeNull();

    const odd = fakeFetch([{ status: 200, body: { result: 'all good' } }]);
    expect(await createBrowserResultReader(odd.fn)(ATTEMPT)).toBeNull();

    const dead = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await createBrowserResultReader(dead)(ATTEMPT)).toBeNull();
  });
});
