/**
 * The decision logic behind POST /api/teacher/questions and
 * POST /api/teacher/papers/<id>/publish (issue 11-ingest-job-review-publish).
 *
 * Kept out of the route files so the tests can drive it directly, the same
 * split as `papers-route.ts` / its route.
 *
 * Order of checks: session, role, config, then the body. A body is never
 * looked at before we know who is asking.
 *
 * WHO the question belongs to is never in the body. It comes from the session,
 * so there is no field a caller could set to write under teacher B's name. A
 * `status` in the body is dropped too (`readQuestionEdit`): a question goes
 * live only through `publish_paper()`, which refuses while anything is
 * unchecked (V9, PRD F-D3).
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `questions_*` policies plus `questions_live_is_checked_check` inside
 * Postgres. Replies carry a fixed short word, so a policy name, a constraint
 * name or a Postgres message never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { readQuestionEdit, type Question, type QuestionsClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SaveQuestionInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: QuestionsClient;
}

export interface SaveQuestionReply {
  status: number;
  body: { ok: true; question: Question } | { error: string };
}

export interface PublishPaperInput {
  paperId: string;
  session: AuthSession | null;
  client: QuestionsClient;
}

export interface PublishPaperReply {
  status: number;
  body: { ok: true; published: number } | { error: string };
}

/** Null when the caller may write, or the reply that turns them away. */
function refuseCaller(
  session: AuthSession | null,
  client: QuestionsClient,
): { status: number; body: { error: string } } | null {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  // A student owns no questions: `questions.teacher_id` references
  // `teachers.user_id`, so Postgres would refuse it anyway. An admin outranks
  // a teacher and is let through.
  if (session.role === 'student') return { status: 403, body: { error: 'teachers only' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };
  return null;
}

export async function handleSaveQuestion({
  body,
  session,
  client,
}: SaveQuestionInput): Promise<SaveQuestionReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  // Drops a `status`, a `teacherId` and anything else that is not one of the
  // nine fields a teacher may set.
  const edit = readQuestionEdit(body);
  if (!edit) return { status: 400, body: { error: 'bad request' } };

  try {
    const question = await client.save(edit);
    return { status: 200, body: { ok: true, question } };
  } catch (cause) {
    // `questions_paper_number_idx`: that number is already in the paper.
    if ((cause as Error)?.name === 'QuestionConflict') {
      return { status: 409, body: { error: 'duplicate number' } };
    }
    // Fixed message: the thrown error may quote a policy.
    return { status: 502, body: { error: 'save failed' } };
  }
}

/**
 * Publish one paper.
 *
 * Every refusal comes from `publish_paper()` inside Postgres, not from a count
 * done here: the screen greys the button out with `publishBlock`, and this is
 * the real gate behind it. So two teachers racing, or a split that restarted
 * one second ago, is decided by the database and not by a stale page.
 */
export async function handlePublishPaper({
  paperId,
  session,
  client,
}: PublishPaperInput): Promise<PublishPaperReply> {
  const refused = refuseCaller(session, client);
  if (refused) return refused;

  if (typeof paperId !== 'string' || !UUID_RE.test(paperId)) {
    return { status: 400, body: { error: 'bad request' } };
  }

  try {
    const published = await client.publishPaper(paperId);
    return { status: 200, body: { ok: true, published } };
  } catch (cause) {
    switch ((cause as Error)?.name) {
      // F-D3: publish stays off until every question is checked.
      case 'PublishUnchecked':
        return { status: 409, body: { error: 'unchecked' } };
      // Risk 1: questions are still arriving, so they cannot all be checked.
      case 'PublishSplitting':
        return { status: 409, body: { error: 'splitting' } };
      // 404, not 403: "that paper exists but is not yours" is nobody's
      // business, and a student asking gets the same answer as a stranger.
      case 'PublishForbidden':
        return { status: 404, body: { error: 'not found' } };
      default:
        return { status: 502, body: { error: 'publish failed' } };
    }
  }
}
