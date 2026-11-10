/**
 * Browser-side exam client (issue 18-exam-mode).
 *
 * The exam player never holds a Supabase key and never sees a token. It posts
 * to our own route handlers; those read the student's access token out of the
 * httpOnly session cookie and let Postgres RLS decide.
 *
 * `saveAnswer` THROWS on failure, on purpose: the queue in
 * `exam-answer-queue.ts` decides what to do with a failure, and it can only do
 * that if it is told. It holds the answer on the phone and sends it when the
 * net returns (issue 58-exam-answer-queue). A refusal AFTER the deadline is a
 * failure like any other and stays one: the queue makes a late answer fail
 * honestly, it never makes one legal, because `attempt_answers_insert_open`
 * and `attempt_answers_update_open` in `0018_exam_mode.sql` are the gate.
 *
 * Until issue 58 there was no queue, and this file's own comment said there
 * was. The failure went straight into a `.catch(() => {})` in the player, so a
 * dropped signal cost the student marks and said nothing.
 *
 * `submit` RETURNS THE SERVER'S SCORE. It is not a number this file can work
 * out: the browser was never given the answer key (F-E5), so the only honest
 * source is the reply from `score_attempt()`.
 *
 * `load` is how the REVIEW happens. The same route that stripped the key
 * before submit hands it over after, because Postgres now has a
 * `submitted_at`. So the review is a re-read, never a key the player was
 * holding back.
 *
 * The thrown message is the HTTP status and nothing else, so a Postgres policy
 * name can never be echoed into the page.
 */
import {
  examAnswerPath,
  examLoadPath,
  examSubmitPath,
  type BrowserExamClient,
  type ExamAnswer,
  type ExamLoad,
} from './types';

export interface BrowserExamClientOptions {
  testId: string;
  /** Null for the full paper. Carried so a re-load reads the same list. */
  topicId?: string | null;
  fetchImpl?: typeof fetch;
}

export function createBrowserExamClient({
  testId,
  topicId = null,
  fetchImpl,
}: BrowserExamClientOptions): BrowserExamClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  async function post(path: string, payload: unknown): Promise<unknown> {
    const res = await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // The cookie is httpOnly and same-origin, so nothing is attached here.
    });
    if (!res.ok) throw new Error('Request failed with status ' + res.status);
    return res.json().catch(() => null);
  }

  return {
    saveAnswer(answer: ExamAnswer): Promise<void> {
      return post(examAnswerPath(testId), answer).then(() => undefined);
    },

    async submit(attemptId: string): Promise<number | null> {
      const body = (await post(examSubmitPath(testId), { attemptId })) as {
        score?: unknown;
      } | null;
      // `0` and a negative score are both real, so this reads the TYPE and
      // never the truthiness of the number.
      return typeof body?.score === 'number' ? body.score : null;
    },

    async load(): Promise<ExamLoad | null> {
      const res = await doFetch(examLoadPath(testId, { topicId }), {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return (await res.json().catch(() => null)) as ExamLoad | null;
    },
  };
}
