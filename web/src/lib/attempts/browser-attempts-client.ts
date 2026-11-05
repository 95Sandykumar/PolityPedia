/**
 * Browser-side attempts client (issue 13-question-player).
 *
 * The player never holds a Supabase key and never sees a token. It posts to
 * our own route handlers; those read the student's access token out of the
 * httpOnly session cookie and let Postgres RLS decide.
 *
 * BOTH CALLS THROW ON FAILURE, on purpose. The retry queue above decides what
 * to do with a failure, and it can only do that if it is told: a resolved
 * promise here would quietly lose the student's answer.
 *
 * The thrown message is the HTTP status and nothing else, so a Postgres policy
 * name can never be echoed into the page.
 */
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

  async function post(path: string, payload: unknown): Promise<void> {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // The cookie is httpOnly and same-origin, so nothing is attached here.
    });
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
