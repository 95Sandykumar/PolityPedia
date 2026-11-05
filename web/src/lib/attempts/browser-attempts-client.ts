/**
 * Browser-side attempts client (issue 13-question-player, 401 retry added by
 * issue 33-session-refresh).
 *
 * The player never holds a Supabase key and never sees a token. It posts to
 * our own route handlers; those read the student's access token out of the
 * httpOnly session cookie and let Postgres RLS decide.
 *
 * ONE RETRY AFTER A 401, AND ONLY ONE. A mock test may run 360 minutes while
 * the access token lasts about 60, so a save WILL come back 401 mid-exam. The
 * client asks `/api/auth/refresh` for new tokens once, then sends the same
 * answer again. If the refresh fails, or the retry is refused too, the call
 * throws and the retry queue holds the answer; it never loops, because a
 * refusal that is really "you are signed out" would otherwise spin for ever
 * on the student's data.
 *
 * BOTH CALLS THROW ON FAILURE, on purpose. The retry queue above decides what
 * to do with a failure, and it can only do that if it is told: a resolved
 * promise here would quietly lose the student's answer.
 *
 * The thrown message is the HTTP status and nothing else, so a Postgres policy
 * name can never be echoed into the page.
 */
import { REFRESH_PATH } from '@/lib/auth/browser-auth-client';
import {
  ATTEMPT_ANSWERS_PATH,
  ATTEMPT_SUBMIT_PATH,
  type AnswerUpsert,
  type AttemptSubmit,
  type BrowserAttemptsClient,
} from './types';

export function createBrowserAttemptsClient(
  fetchImpl?: typeof fetch,
): BrowserAttemptsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  function send(path: string, payload: unknown): Promise<Response> {
    return doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // The cookie is httpOnly and same-origin, so nothing is attached here.
    });
  }

  async function post(path: string, payload: unknown): Promise<void> {
    let res = await send(path, payload);

    // 401 is the one status worth a second try: it means the hour ran out, not
    // that the answer was wrong.
    if (res.status === 401) {
      const renewed = await send(REFRESH_PATH, {});
      if (renewed.ok) res = await send(path, payload);
    }

    if (!res.ok) throw new Error('Request failed with status ' + res.status);
  }

  return {
    saveAnswer(answer: AnswerUpsert): Promise<void> {
      return post(ATTEMPT_ANSWERS_PATH, answer);
    },

    submit(input: AttemptSubmit): Promise<void> {
      return post(ATTEMPT_SUBMIT_PATH, input);
    },
  };
}
