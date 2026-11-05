/**
 * Browser-side questions client (issue 11-ingest-job-review-publish).
 *
 * The review screen never holds a Supabase key and never sees a token. It
 * posts to our own route handlers; those read the teacher's access token out
 * of the httpOnly session cookie and let Postgres RLS decide.
 *
 * Security: the thrown message is a short CODE of ours or the HTTP status, so
 * a Postgres policy name is never echoed into the page. The form turns each
 * code into one line of Hindi or English.
 */
import type { BrowserQuestionsClient, Question, QuestionEdit } from './types';

export const TEACHER_QUESTIONS_PATH = '/api/teacher/questions';

/** Our own publish route for one paper. */
export function paperPublishPath(paperId: string): string {
  return `/api/teacher/papers/${encodeURIComponent(paperId)}/publish`;
}

/** Codes the review screen turns into one short line. Never a server message. */
export type ReviewErrorCode =
  | 'duplicate-number'
  | 'unchecked'
  | 'splitting'
  | 'not-found';

function refuse(code: ReviewErrorCode): never {
  throw new Error(code);
}

export function createBrowserQuestionsClient(
  fetchImpl?: typeof fetch,
): BrowserQuestionsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async save(edit: QuestionEdit): Promise<Question> {
      const res = await doFetch(TEACHER_QUESTIONS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edit),
      });

      if (res.status === 409) refuse('duplicate-number');
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { question?: Question };
      if (!body?.question) throw new Error('Request failed with status ' + res.status);
      return body.question;
    },

    async publish(paperId: string): Promise<number> {
      const res = await doFetch(paperPublishPath(paperId), { method: 'POST' });

      if (res.status === 404) refuse('not-found');
      if (res.status === 409) {
        // Which 409 it is decides which line the teacher reads: "check every
        // question" or "the split is still running".
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        refuse(body?.error === 'splitting' ? 'splitting' : 'unchecked');
      }
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { published?: unknown };
      return typeof body?.published === 'number' ? body.published : 0;
    },
  };
}
