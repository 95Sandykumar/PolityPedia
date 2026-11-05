/**
 * Thumbs up / down on an AI explanation (issue 23-revision-screen).
 *
 * DESIGN.md section 8: "Thumbs up/down under it (feedback goes to the
 * teacher)." The table is `ai_feedback` in `0023_ai_feedback.sql`, keyed
 * `(user_id, question_id, lang)`, so a student has ONE opinion per
 * explanation however many times they tap.
 *
 * Nothing here reads `process.env` or calls `fetch`, so this file is safe to
 * import from the browser bundle as well as the route handler.
 */
import type { Lang } from '@/lib/i18n';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Two thumbs, the same two values the CHECK in the migration allows. */
export type FeedbackVote = 'up' | 'down';

export const FEEDBACK_VOTES: readonly FeedbackVote[] = ['up', 'down'];

export function isFeedbackVote(value: unknown): value is FeedbackVote {
  return typeof value === 'string' && (FEEDBACK_VOTES as readonly string[]).includes(value);
}

export interface FeedbackRequest {
  questionId: string;
  lang: Lang;
  vote: FeedbackVote;
}

/**
 * Validate anything into a `FeedbackRequest`, or null.
 *
 * `lang` is a stored LANGUAGE, never the display mode `both`: a vote is about
 * one piece of writing, and an explanation is written in one language.
 */
export function readFeedbackRequest(body: unknown): FeedbackRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  // Accepted under the wire name the table uses, so the route body, the REST
  // call and the column are all spelled the same.
  const questionId = raw.question_id ?? raw.questionId;
  if (typeof questionId !== 'string' || !UUID_RE.test(questionId)) return null;

  const lang = raw.lang;
  if (lang !== 'en' && lang !== 'hi') return null;

  const vote = raw.vote;
  if (!isFeedbackVote(vote)) return null;

  return { questionId, lang, vote };
}

/**
 * The write, behind one interface. Server side: it carries the student's own
 * access token, so the policies in `0023_ai_feedback.sql` are the real gate
 * and `user_id` comes from `auth.uid()`, never from the request.
 */
export interface FeedbackClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** Upsert the student's one vote. Throws on an HTTP failure. */
  save(request: FeedbackRequest): Promise<void>;
}
