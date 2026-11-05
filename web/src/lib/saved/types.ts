/**
 * The Saved list contract (issue 14-saved-list).
 *
 * PRD F-E8: ONE saved list with TWO tags, Wrong and Marked. So a saved thing
 * is a `(questionId, tag)` pair and nothing else: no interval, no review
 * counter, no spaced repetition (the issue scope guard).
 *
 * Supabase sits behind the interfaces at the bottom, so tests fake them: no
 * real network call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 *  * `SavedClient`        -- server side, carries the student's own access
 *                            token, so Postgres RLS (`saved_questions_*_own`)
 *                            decides.
 *  * `BrowserSavedClient` -- the player and the Saved tab. Posts to our own
 *                            route, holds no key.
 *
 * The validation below is a COPY of the SQL constraints in 0014, on purpose:
 * the database is the gate, and this keeps a bad shape out of the REST call.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two tags of F-E8, in the order the chips are drawn. */
export type SavedTag = 'wrong' | 'marked';

export const SAVED_TAGS: readonly SavedTag[] = ['wrong', 'marked'];

export function isSavedTag(value: unknown): value is SavedTag {
  return typeof value === 'string' && (SAVED_TAGS as readonly string[]).includes(value);
}

/** Our own route the player and the Saved tab post to. Holds no key. */
export const SAVED_PATH = '/api/saved';

/**
 * One row of the Saved tab: the saved pair plus the bits of the question the
 * list needs to draw a row and open the player.
 *
 * The question fields come from the embedded `questions` row, so they are
 * already filtered by `questions_select_live`: a draft question cannot appear
 * here at all.
 */
export interface SavedItem {
  questionId: string;
  tag: SavedTag;
  /** When it was first saved. Null only if Postgres ever hands back nothing. */
  createdAt: string | null;
  teacherId: string;
  /** Null for a mock-test question (issue 15), which has no paper to open. */
  paperId: string | null;
  number: number;
  stem: string;
}

/** One save or un-save, on its way from the browser to the server. */
export interface SavedWrite {
  questionId: string;
  tag: SavedTag;
  /** The state the student wants, not the state they came from. */
  saved: boolean;
}

/**
 * Validate anything into a `SavedWrite`, or null.
 *
 * Only the three fields below are carried over, so a `userId` in the body is
 * DROPPED right here rather than refused: who owns the row is decided by RLS
 * over the session token, never by a field.
 */
export function readSavedWrite(body: unknown): SavedWrite | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;

  // The id goes into a REST URL, so its shape is checked before that.
  if (typeof raw.questionId !== 'string' || !UUID_RE.test(raw.questionId)) return null;
  if (!isSavedTag(raw.tag)) return null;
  // A real boolean: the string "false" must not read as a yes.
  if (typeof raw.saved !== 'boolean') return null;

  return { questionId: raw.questionId, tag: raw.tag, saved: raw.saved };
}

/**
 * The chip filter. `null` is "no chip picked", which shows BOTH tags, because
 * F-E8 is one list and the chips only narrow it.
 */
export function filterSaved(
  items: readonly SavedItem[],
  tag: SavedTag | null,
): SavedItem[] {
  if (tag === null) return [...items];
  return items.filter((one) => one.tag === tag);
}

/** How many rows carry this tag, for the number on its chip. */
export function countByTag(items: readonly SavedItem[], tag: SavedTag): number {
  let total = 0;
  for (const one of items) if (one.tag === tag) total += 1;
  return total;
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** Server side. Carries the student's own access token, so RLS decides. */
export interface SavedClient {
  /** False when the Supabase env vars are missing, so the tab can say so. */
  isConfigured(): boolean;
  /** The caller's own saved list, newest first. Empty on any failure. */
  list(): Promise<SavedItem[]>;
  /** Save one tag. Idempotent: the same save twice is one row (0014). */
  save(questionId: string, tag: SavedTag): Promise<void>;
  /** Drop one tag of one question. The other tag is left alone. */
  remove(questionId: string, tag: SavedTag): Promise<void>;
}

/** Browser side: the player and the Saved tab. Calls our own route. */
export interface BrowserSavedClient {
  /** `saved` is the state the student wants, not the state they came from. */
  setSaved(questionId: string, tag: SavedTag, saved: boolean): Promise<void>;
}
