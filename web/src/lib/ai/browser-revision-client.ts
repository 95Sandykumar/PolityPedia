/**
 * Browser-side revision client (issue 23-revision-screen).
 *
 * The screen never holds a Supabase key, never holds the Claude key and never
 * sees a token. It posts to our own route handlers; those read the student's
 * access token out of the httpOnly session cookie and let Postgres decide
 * (the plan, the 30-a-day cap and who calls the model).
 *
 * NEITHER METHOD THROWS. Every reply of `/api/revision` is a state of the
 * screen, so a rejected promise would only make the component invent the same
 * four cases again in a `catch`. A dead network is `ai_failed`, which reads
 * "Could not write the explanation. Try again." -- which is exactly what
 * happened.
 *
 * Security: the outcome carries one of our own fixed codes, never a server
 * message, so a Postgres policy name or a URL cannot be echoed into the page.
 */
import { readExplanationRow } from './explanation-row';
import {
  isRevisionError,
  type BrowserRevisionClient,
  type RevisionOutcome,
} from './revision-screen';
import type { FeedbackRequest } from './feedback';
import type { RevisionRequest } from './types';

export const REVISION_PATH = '/api/revision';
export const REVISION_FEEDBACK_PATH = '/api/revision/feedback';

/** The reply body of a 200: a row, flattened by `revision-route.ts`. */
interface ReadyBody {
  status?: unknown;
  questionId?: unknown;
  lang?: unknown;
  body?: unknown;
  sources?: unknown;
  audioPath?: unknown;
  editedByTeacher?: unknown;
  error?: unknown;
}

/**
 * The 200 body uses the app's own camelCase names, so it is turned back into
 * the row shape the one reader understands. One parser for the reply and the
 * Realtime push (`explanation-row.ts`).
 */
function readReply(body: ReadyBody, request: RevisionRequest): RevisionOutcome {
  const explanation = readExplanationRow({
    question_id: typeof body.questionId === 'string' ? body.questionId : request.questionId,
    lang: body.lang === 'en' || body.lang === 'hi' ? body.lang : request.lang,
    status: 'ready',
    body: body.body,
    sources: body.sources,
    audio_path: body.audioPath,
    edited_by_teacher: body.editedByTeacher,
  });

  // A 200 with nothing renderable in it is a failure, not an empty card.
  if (!explanation || !explanation.body) return { kind: 'error', error: 'ai_failed' };
  return { kind: 'ready', explanation };
}

export function createBrowserRevisionClient(
  fetchImpl?: typeof fetch,
): BrowserRevisionClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async explain(request: RevisionRequest): Promise<RevisionOutcome> {
      let res: Response;
      try {
        res = await doFetch(REVISION_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question_id: request.questionId, lang: request.lang }),
        });
      } catch {
        // Offline, or the request was cut. Same line as a model failure,
        // because the fix is the same: try again.
        return { kind: 'error', error: 'ai_failed' };
      }

      const body = (await res.json().catch(() => null)) as ReadyBody | null;

      if (res.status === 200 && body) return readReply(body, request);
      // 202: somebody's call is in flight. The screen now WAITS on the push.
      if (res.status === 202) return { kind: 'generating' };

      // Issue 22 answers with a fixed code. Anything else is a reply we do not
      // know, and a generic "try again" is the honest label for it.
      const error = body?.error;
      return { kind: 'error', error: isRevisionError(error) ? error : 'ai_failed' };
    },

    async vote(request: FeedbackRequest): Promise<boolean> {
      try {
        const res = await doFetch(REVISION_FEEDBACK_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            question_id: request.questionId,
            lang: request.lang,
            vote: request.vote,
          }),
        });
        return res.ok;
      } catch {
        // A lost vote is not worth a line of error text on a screen the
        // student opened to read an explanation.
        return false;
      }
    },
  };
}
