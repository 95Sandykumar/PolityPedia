/**
 * Issue 33-session-refresh: an exam must survive the hour mark.
 *
 * A mock test can run 360 minutes and the access token dies at about 60, so
 * one answer save WILL come back 401 in a three hour sitting. The client asks
 * for a refresh once and sends the answer again, so the student loses nothing.
 *
 * `fetch` is injected: no network call anywhere here.
 */
import { describe, expect, it, vi } from 'vitest';
import { REFRESH_PATH } from '@/lib/auth/browser-auth-client';
import { createBrowserAttemptsClient } from '../browser-attempts-client';
import { ATTEMPT_ANSWERS_PATH, ATTEMPT_SUBMIT_PATH, type AnswerUpsert } from '../types';

const answer: AnswerUpsert = {
  attemptId: '11111111-1111-4111-8111-111111111111',
  questionId: '22222222-2222-4222-8222-222222222222',
  chosenIdx: 2,
  isCorrect: true,
  marked: false,
};

/** A fetch that answers with the given statuses, in order. */
function fakeFetch(statuses: number[]) {
  const paths: string[] = [];
  const queue = [...statuses];
  const fn = vi.fn(async (path: string | URL) => {
    paths.push(String(path));
    return new Response(null, { status: queue.shift() ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, paths };
}

describe('createBrowserAttemptsClient', () => {
  it('saves an answer in one call while the token is alive', async () => {
    const fetchImpl = fakeFetch([200]);
    await createBrowserAttemptsClient(fetchImpl.fn).saveAnswer(answer);
    expect(fetchImpl.paths).toEqual([ATTEMPT_ANSWERS_PATH]);
  });

  it('refreshes once and retries the answer after a 401', async () => {
    // save -> 401, refresh -> 200, save again -> 200.
    const fetchImpl = fakeFetch([401, 200, 200]);
    await createBrowserAttemptsClient(fetchImpl.fn).saveAnswer(answer);
    expect(fetchImpl.paths).toEqual([ATTEMPT_ANSWERS_PATH, REFRESH_PATH, ATTEMPT_ANSWERS_PATH]);
  });

  it('does the same for submit, so submitted_at still gets set', async () => {
    const fetchImpl = fakeFetch([401, 200, 200]);
    await createBrowserAttemptsClient(fetchImpl.fn).submit({
      attemptId: answer.attemptId,
      score: 64,
    });
    expect(fetchImpl.paths).toEqual([ATTEMPT_SUBMIT_PATH, REFRESH_PATH, ATTEMPT_SUBMIT_PATH]);
  });

  it('never loops: the refresh works but the save is still refused', async () => {
    // save -> 401, refresh -> 200, save again -> 401, and then it STOPS.
    const fetchImpl = fakeFetch([401, 200, 401, 200, 401, 200]);
    const client = createBrowserAttemptsClient(fetchImpl.fn);

    await expect(client.saveAnswer(answer)).rejects.toThrow('401');
    // Exactly three: the save, the one refresh, the one retry.
    expect(fetchImpl.paths).toEqual([ATTEMPT_ANSWERS_PATH, REFRESH_PATH, ATTEMPT_ANSWERS_PATH]);
  });

  it('does not retry when the refresh itself fails', async () => {
    const fetchImpl = fakeFetch([401, 401]);
    const client = createBrowserAttemptsClient(fetchImpl.fn);

    await expect(client.saveAnswer(answer)).rejects.toThrow('401');
    expect(fetchImpl.paths).toEqual([ATTEMPT_ANSWERS_PATH, REFRESH_PATH]);
  });

  it('does not refresh for a failure that is not about the token', async () => {
    const fetchImpl = fakeFetch([502]);
    const client = createBrowserAttemptsClient(fetchImpl.fn);

    await expect(client.saveAnswer(answer)).rejects.toThrow('502');
    expect(fetchImpl.paths).toEqual([ATTEMPT_ANSWERS_PATH]);
  });
});
