/**
 * The decision logic behind POST /api/attempts/answers and
 * POST /api/attempts/submit (issue 13-question-player).
 *
 * Kept out of the route files so the tests drive it directly, the same split
 * as `questions-route.ts` in issue 11.
 *
 * Order of checks: session, config, then the body. A body is never looked at
 * before we know who is asking.
 *
 * WHO OWNS THE ATTEMPT IS NEVER IN THE BODY. It comes from the session token,
 * and `attempt_answers_insert_own` re-reads it inside Postgres through the
 * parent `attempts` row, so a caller who posts somebody else's `attemptId`
 * gets a refusal from the database and not from a count done here.
 *
 * There is NO ROLE CHECK. An attempt hangs on `auth.users`, so a teacher
 * sitting their own paper is a normal thing to do, and blocking it would be a
 * rule nobody asked for.
 *
 * Security: this is defence in depth, not the gate. Replies carry a fixed
 * short word, so a policy name, a constraint name or a Postgres message never
 * reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { readAnswerUpsert, readAttemptSubmit, type AttemptsClient } from './types';

export interface AttemptsRouteInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: AttemptsClient;
}

export interface AttemptsRouteReply {
  status: number;
  body: { ok: true } | { error: string };
}

/** Null when the caller may write, or the reply that turns them away. */
function refuseCaller(
  session: AuthSession | null,
  client: AttemptsClient,
): AttemptsRouteReply | null {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };
  return null;
}

/**
 * Store one answer.
 *
 * The write is an UPSERT keyed `(attempt_id, question_id)`, so this route is
 * safe to call with the same answer twice (A1). That is what lets the player's
 * retry queue send a held answer without checking whether it already arrived.
 */
export async function handleSaveAnswer({
  body,
  session,
  client,
}: AttemptsRouteInput): Promise<AttemptsRouteReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  // Drops a `userId`, a `score` and anything else that is not one of the five
  // fields an answer is made of.
  const answer = readAnswerUpsert(body);
  if (!answer) return { status: 400, body: { error: 'bad request' } };

  try {
    await client.saveAnswer(answer);
    return { status: 200, body: { ok: true } };
  } catch {
    // Fixed message: the thrown error may quote a policy.
    return { status: 502, body: { error: 'save failed' } };
  }
}

/**
 * Close one sitting.
 *
 * The body's `score` is the number the player already shows; it is NOT what
 * gets stored. `score_attempt()` in Postgres marks the paper itself and writes
 * `submitted_at` and `score`, because a caller who could write those could
 * write 999 (issue 31-attempt-score-guard).
 */
export async function handleSubmitAttempt({
  body,
  session,
  client,
}: AttemptsRouteInput): Promise<AttemptsRouteReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  const submit = readAttemptSubmit(body);
  if (!submit) return { status: 400, body: { error: 'bad request' } };

  try {
    await client.submit(submit);
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 502, body: { error: 'submit failed' } };
  }
}
