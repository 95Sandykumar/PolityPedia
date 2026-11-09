/**
 * The browser's way to the result of a sitting (issue 56-result-page).
 *
 * The player submits in the browser, so the payoff screen has to arrive
 * without a page load. This reads our own route, which runs
 * `readAttemptResult()` (ticket 56a) on the server with the student's own
 * access token out of the httpOnly session cookie. No key and no token lives
 * in the browser, and the reader's four rules stay where Postgres can enforce
 * them.
 *
 * ONE RETRY AFTER A 401, AND ONLY ONE, exactly as the answer client does: a
 * mock test may run 360 minutes while the access token lasts about 60, so the
 * read that follows the final submit is the one most likely to be refused for
 * age rather than for ownership.
 *
 * THIS ONE FAILS SOFT, and that is the opposite of the answer client. A lost
 * answer must be told about, because the retry queue is the only thing that
 * can save it. A result that will not load costs nothing: the score the submit
 * handed back is already on screen, so null here simply means the breakdown
 * stays away and the student taps again or re-opens the paper.
 */
import { REFRESH_PATH } from '@/lib/auth/browser-auth-client';
import { attemptResultPath, type AttemptResult } from './types';

/** Reads one sitting's result, or null when there is nothing to show. */
export type BrowserResultReader = (attemptId: string) => Promise<AttemptResult | null>;

export function createBrowserResultReader(fetchImpl?: typeof fetch): BrowserResultReader {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  function get(path: string): Promise<Response> {
    return doFetch(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // A student's own sitting and its mark. A cached copy would hand the
      // next reader of this browser somebody else's result.
      cache: 'no-store',
    });
  }

  return async function readResult(attemptId: string): Promise<AttemptResult | null> {
    try {
      const path = attemptResultPath(attemptId);
      let res = await get(path);

      // 401 means the hour ran out, not that the sitting is somebody else's.
      if (res.status === 401) {
        const renewed = await doFetch(REFRESH_PATH, { method: 'POST' });
        if (renewed.ok) res = await get(path);
      }

      if (!res.ok) return null;

      const body = (await res.json()) as unknown;
      if (!body || typeof body !== 'object') return null;

      // The route sends `{ result: ... | null }`, so an open sitting, a missing
      // one and another student's one all arrive the same way (0013).
      const found = (body as { result?: unknown }).result;
      return found && typeof found === 'object' ? (found as AttemptResult) : null;
    } catch {
      // A dead network, not a wrong answer. The score line stands.
      return null;
    }
  };
}
