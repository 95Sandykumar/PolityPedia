/**
 * The decision logic behind the three exam routes (issue 18-exam-mode):
 *
 *   GET  /api/tests/<id>/load?mode=exam  -> questions WITHOUT the answer key
 *   POST /api/tests/<id>/answer          -> one answer, with no verdict
 *   POST /api/tests/<id>/submit          -> the SERVER marks and closes it
 *
 * Kept out of the route files so the tests drive it directly, the same split
 * as `attempts-route.ts` in issue 13.
 *
 * Order of checks: session, config, then the query or the body. Nothing a
 * caller sent is looked at before we know who is asking.
 *
 * F-E5 IS ENFORCED TWICE ON PURPOSE. `readExamLoad` builds the payload through
 * `examQuestions`, and `guardAnswerKey` below walks the finished reply before
 * it leaves. One is the rule; the other is the proof. An answer key is the one
 * thing in this product that cannot be taken back once it has been sent, so it
 * gets a second look.
 *
 * ONLY `mode=exam` IS SERVED HERE. A practice payload carries the key by
 * design (D3 shows the result after every tap), so a route that answered
 * `mode=practice` would be a hole with a friendly name. Practice is the server
 * component in issue 17, which never crosses a public URL.
 *
 * Security: this is defence in depth, not the gate. The gates are
 * `attempt_answers_insert_open` / `_update_open` and `score_attempt()` inside
 * Postgres. Replies carry a fixed short word, so a policy name, a constraint
 * name or a Postgres message never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { LangMode } from '@/lib/i18n';
import { readTopicFilter } from '@/lib/practice/types';
import type { Question } from '@/lib/questions/types';
import {
  EXAM_MODE,
  carriesAnswerKey,
  readExamAnswer,
  readExamSubmit,
  stripAnswerKey,
  type ExamClient,
  type ExamLoad,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the reader needs to know, beyond the test id. */
export interface ExamLoadOptions {
  /** Null for the full paper, which is the default (V12, F-E3). */
  topicId: string | null;
  /** The student's saved language, for the exam name in the heading. */
  langMode: LangMode;
}

export interface ExamLoadInput {
  testId: string;
  /** The request query, unparsed: `mode` and `topic` are validated here. */
  query: Record<string, string | string[] | undefined>;
  session: AuthSession | null;
  langMode: LangMode;
  /**
   * The read itself, injected so the tests drive these rules without a
   * network call. The route file passes `readExamLoad` from `student-page.ts`.
   */
  load: (testId: string, options: ExamLoadOptions) => Promise<ExamLoad>;
}

export interface ExamLoadReply {
  status: number;
  body: ExamLoad | { error: string };
}

export interface ExamWriteInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  session: AuthSession | null;
  client: ExamClient;
}

export interface ExamAnswerReply {
  status: number;
  body: { ok: true } | { error: string };
}

export interface ExamSubmitReply {
  status: number;
  body: { ok: true; score: number | null } | { error: string };
}

/** Null when the caller may go on, or the reply that turns them away. */
function refuseCaller(
  session: AuthSession | null,
  client: ExamClient,
): { status: number; body: { error: string } } | null {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };
  return null;
}

/** The first value of a query key, however the framework handed it over. */
function one(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The last gate on F-E5.
 *
 * STRIPS rather than refuses. A bug of ours upstream must not cost a student
 * their exam, and it must not ship the key either, so the payload is simply
 * put back into the shape it should have been in. `revealed` is the one state
 * where the key is meant to be there, so that one passes straight through.
 */
function guardAnswerKey(load: ExamLoad): ExamLoad {
  if (load.revealed || !carriesAnswerKey(load.questions)) return load;
  return { ...load, questions: load.questions.map((q) => stripAnswerKey(q as Question)) };
}

/**
 * The exam payload: the questions, the timed sitting, its answers so far, the
 * exam's marking and the heading.
 *
 * The sitting is CREATED (or resumed) by the read, which is what makes opening
 * this route the start of the clock: `deadline_at = now + duration`.
 */
export async function handleExamLoad({
  testId,
  query,
  session,
  langMode,
  load,
}: ExamLoadInput): Promise<ExamLoadReply> {
  if (!session) return { status: 401, body: { error: 'sign in' } };

  // Exactly `exam`, with no trimming and no case folding: the link is one we
  // build ourselves, so anything else is a caller guessing.
  if (one(query.mode) !== EXAM_MODE) {
    return { status: 400, body: { error: 'exam mode only' } };
  }

  // The id goes into a REST URL, so the shape is checked before that.
  if (!UUID_RE.test(testId)) return { status: 400, body: { error: 'bad request' } };

  try {
    const data = await load(testId, {
      // "Full paper" is the absence of a filter, so `all` reads as null.
      topicId: readTopicFilter(query.topic),
      langMode,
    });
    return { status: 200, body: guardAnswerKey(data) };
  } catch {
    // Fixed message: the thrown error may quote a policy.
    return { status: 502, body: { error: 'load failed' } };
  }
}

/**
 * Store one answer of the caller's own timed sitting.
 *
 * The write is an UPSERT keyed `(attempt_id, question_id)`, so this route is
 * safe to call with the same answer twice (A1). What it cannot do is carry a
 * verdict: `readExamAnswer` has no field for one.
 */
export async function handleExamAnswer({
  body,
  session,
  client,
}: ExamWriteInput): Promise<ExamAnswerReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  const answer = readExamAnswer(body);
  if (!answer) return { status: 400, body: { error: 'bad request' } };

  try {
    await client.saveExamAnswer(answer);
    return { status: 200, body: { ok: true } };
  } catch {
    // Includes the normal case of an answer that arrived after the deadline:
    // Postgres refused it, and the student's clock already says why.
    return { status: 502, body: { error: 'save failed' } };
  }
}

/**
 * Close the sitting and hand back the score.
 *
 * The number comes from `score_attempt()` in Postgres, never from the body:
 * the browser was never given the answer key, so it has no score to offer and
 * no field to offer one in. Calling this twice gives the same number, because
 * the function returns the stored score for a sitting that is already closed.
 */
export async function handleExamSubmit({
  body,
  session,
  client,
}: ExamWriteInput): Promise<ExamSubmitReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  const submit = readExamSubmit(body);
  if (!submit) return { status: 400, body: { error: 'bad request' } };

  try {
    const score = await client.scoreAttempt(submit.attemptId);
    return { status: 200, body: { ok: true, score } };
  } catch {
    return { status: 502, body: { error: 'submit failed' } };
  }
}
