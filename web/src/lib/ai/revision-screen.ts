/**
 * What the Revision (AI) screen talks to (issue 23-revision-screen).
 *
 * The screen holds NO key and opens no socket of its own: both of the things
 * it needs are interfaces here, and both are faked in its test.
 *
 *  * `BrowserRevisionClient` -- posts to our own route handlers. The route
 *    holds the session cookie, so the student's token never reaches the page.
 *  * `ExplanationLive`       -- B6: a second student waiting on somebody
 *    else's call is PUSHED the finished row. There is no timer in this slice.
 *
 * WHY `explain` RETURNS AND NEVER THROWS. Every reply the revision route can
 * give is a STATE OF THE SCREEN, not an accident: no plan is the Rs 100 card,
 * limit is one sentence, generating is the skeleton. A thrown error would make
 * the component tell the four apart by reading a message, and issue 22
 * deliberately answers with a fixed code so that is never necessary. The code
 * is looked up in `REVISION_ERROR_LABEL` (issue 22), so no reply can reach a
 * screen as an English-only string.
 *
 * Nothing here reads `process.env` or calls `fetch`.
 */
import type { Lang } from '@/lib/i18n';
import type { FeedbackRequest } from './feedback';
import type { RevisionError } from './revision-route';
import type { Explanation, RevisionRequest } from './types';

/**
 * Where Subscribe goes. Issue 28 builds the real page on the Me tab ("Plan
 * page on the Me tab"); until then this is a placeholder that says so, which
 * is better than a button that goes nowhere.
 */
export const PLANS_PATH = '/me/plans';

const REVISION_ERRORS: readonly RevisionError[] = [
  'rate',
  'sign_in',
  'bad_request',
  'not_configured',
  'no_plan',
  'not_found',
  'limit',
  'ai_failed',
];

export function isRevisionError(value: unknown): value is RevisionError {
  return typeof value === 'string' && (REVISION_ERRORS as readonly string[]).includes(value);
}

/** The three things that can come back, as three states of the screen. */
export type RevisionOutcome =
  /** 200. Saved or just written. Render it. */
  | { kind: 'ready'; explanation: Explanation }
  /** 202. Somebody's call is in flight: wait on the push, do not ask again. */
  | { kind: 'generating' }
  /** Everything else, as one code with one label per language. */
  | { kind: 'error'; error: RevisionError };

export interface BrowserRevisionClient {
  /** Ask for the explanation. Never throws: a failure is an `error` outcome. */
  explain(request: RevisionRequest): Promise<RevisionOutcome>;
  /** Thumbs up / down. True when it was stored. Never throws. */
  vote(request: FeedbackRequest): Promise<boolean>;
}

/**
 * A pushed stream of one `ai_explanations` row.
 *
 * Supabase Realtime in production, a fake in tests. B6: the row is pushed, so
 * the screen has no `setInterval` in it. A second student who tapped Revision
 * one moment after the first one waits HERE, not in a retry loop.
 */
export interface ExplanationLive {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /**
   * Watch one explanation. Returns the function that stops watching; calling
   * it twice is safe, because React runs a cleanup twice on a fast remount.
   */
  watchExplanation(
    key: RevisionRequest,
    onChange: (explanation: Explanation) => void,
  ): () => void;
}

/** The key as one string, for a watcher map and a Realtime topic. */
export function explanationKey(questionId: string, lang: Lang): string {
  return `${questionId}:${lang}`;
}

/**
 * Which language the explanation is asked for in.
 *
 * `both` is a DISPLAY mode, never a stored language (see `types.ts`), so a
 * student reading both falls back to the language the question itself is
 * written in: explaining a Hindi question in English would be the odd answer.
 */
export function explanationLang(mode: Lang | 'both', questionLang: Lang): Lang {
  return mode === 'both' ? questionLang : mode;
}
