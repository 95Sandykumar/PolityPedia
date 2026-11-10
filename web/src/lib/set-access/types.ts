/**
 * The set-access contract (issue 16-set-access-mock-list).
 *
 * `set_access` is the row that says "this user may read this mock set". The
 * gate itself is SQL (`0016_set_access.sql`: `has_test_access()` plus the
 * restrictive policy on `questions`). Everything in this file is so a SCREEN
 * can show the right thing: a price or "Unlocked", a lock or an Attempt
 * button, a tick and a score.
 *
 * Nothing here is permission. A student who edits the JSON still reads zero
 * locked questions, because Postgres decides.
 *
 * Supabase sits behind the interfaces at the bottom, so tests fake them: no
 * real network call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 *  * `SetAccessClient`        -- server side, carries the caller's own access
 *                               token, so the `set_access_*` policies decide.
 *  * `AdminSetAccessClient`   -- the admin screen. Posts to our own route and
 *                               never sees a key.
 *
 * NOT HERE: taking the money (issues 26 and 27) and batch grants (issue 19).
 * The only `source` this slice writes is `admin`.
 */
import { labels, type LangMode } from '@/lib/i18n';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a `set_access` row exists. Same list as `set_access_source_check`. */
export type AccessSource = 'purchase' | 'batch' | 'admin';

export const ACCESS_SOURCES: readonly AccessSource[] = ['purchase', 'batch', 'admin'];

export function isAccessSource(value: unknown): value is AccessSource {
  return typeof value === 'string' && (ACCESS_SOURCES as readonly string[]).includes(value);
}

/** One row of `set_access`, as the app passes it around. */
export interface SetAccess {
  setId: string;
  source: AccessSource;
  /** ISO timestamp, or the literal `infinity` for a bought set. */
  validUntil: string;
}

/** What the admin screen sends to grant a set. The source is always `admin`. */
export interface GrantSetInput {
  userId: string;
  setId: string;
  /** ISO timestamp. The grant is live while this is in the future. */
  validUntil: string;
}

/** Ending a grant: the row is deleted, so the student is locked out at once. */
export interface RevokeSetInput {
  userId: string;
  setId: string;
}

/** The last submitted sitting of one test, for the tick and the score. */
export interface TestScore {
  testId: string;
  /** Marks after negative marking. Null means taken but not scored. */
  score: number | null;
}

/**
 * Postgres `timestamptz` has an `infinity`, and PostgREST sends it as that
 * word. `Date.parse('infinity')` is NaN, which would read as EXPIRED and lock
 * a student out of a set they bought, so it is spelled out here.
 */
export function isValidUntilLive(validUntil: string, now: number): boolean {
  const text = validUntil.trim().toLowerCase();
  if (text === 'infinity') return true;
  if (text === '-infinity') return false;
  const at = Date.parse(validUntil);
  // An unreadable date fails CLOSED. A locked set a student owns is a support
  // ticket; an open set they do not own is the product given away.
  if (!Number.isFinite(at)) return false;
  return at > now;
}

/** True when any of this student's rows for that set is still live. */
export function isSetUnlocked(
  access: readonly SetAccess[],
  setId: string,
  now: number = Date.now(),
): boolean {
  return access.some((one) => one.setId === setId && isValidUntilLive(one.validUntil, now));
}

/**
 * The topic choice above the list. "Full paper" is the DEFAULT (V12, F-E3) and
 * is not a topic id, so it is a word, not a uuid.
 *
 * v1 has no topic catalogue yet (design.md: "`topics`: reuse v0 `taxonomy`"),
 * so the dropdown is handed an EMPTY topic list for now and shows Full paper
 * on its own. The value still travels into the player link, so issue
 * 17-practice-mode only has to read it, not invent it.
 */
export const MOCK_TOPIC_ALL = 'all';

/** One option in the topic dropdown. `name` is already in the right language. */
export interface MockTopic {
  id: string;
  name: string;
}

/** One test as the list draws it. */
export interface MockTestRow {
  id: string;
  title: string;
  position: number;
  isFreeSample: boolean;
  /**
   * True when this student can actually open it: the set is unlocked, or it is
   * the free sample. The same rule as `has_test_access()` in SQL, which is the
   * one that counts.
   */
  open: boolean;
  /**
   * Marks of the last submitted sitting, or null when it has never been taken.
   * A number here is what puts the tick on the row.
   *
   * Marks only, with no "/ 200" beside it: the total comes from the exam's
   * marking (F-E6), which arrives with issue 17-practice-mode.
   */
  score: number | null;
}

/** One set as the list draws it: a header plus its tests. */
export interface MockSetRow {
  id: string;
  title: string;
  priceInr: number;
  unlocked: boolean;
  tests: MockTestRow[];
}

export interface BuildMockRowsInput {
  sets: readonly { id: string; title: string; priceInr: number }[];
  tests: readonly {
    id: string;
    setId: string;
    title: string;
    position: number;
    isFreeSample: boolean;
  }[];
  /** The signed-in student's own `set_access` rows. */
  access: readonly SetAccess[];
  /** The student's own last submitted sitting per test. */
  scores?: readonly TestScore[];
  now?: number;
}

/**
 * Turn four reads into the rows the list draws, in Test 1, 2, 3 order.
 *
 * A test whose set is missing is DROPPED, not shown under a made-up header: a
 * row with no price is a row a student cannot judge.
 */
export function buildMockRows({
  sets,
  tests,
  access,
  scores = [],
  now = Date.now(),
}: BuildMockRowsInput): MockSetRow[] {
  const byTest = new Map(scores.map((one) => [one.testId, one.score]));

  const rows: MockSetRow[] = sets.map((set) => ({
    id: set.id,
    title: set.title,
    priceInr: set.priceInr,
    unlocked: isSetUnlocked(access, set.id, now),
    tests: [],
  }));
  const bySet = new Map(rows.map((row) => [row.id, row]));

  for (const test of tests) {
    const row = bySet.get(test.setId);
    if (!row) continue;
    row.tests.push({
      id: test.id,
      title: test.title,
      position: test.position,
      isFreeSample: test.isFreeSample,
      open: row.unlocked || test.isFreeSample,
      // `has` and not `?? null`: a sitting scored 0 is still a sitting, and
      // `0 || null` would quietly turn it into "never taken".
      score: byTest.has(test.id) ? (byTest.get(test.id) ?? null) : null,
    });
  }

  for (const row of rows) row.tests.sort((a, b) => a.position - b.position);
  return rows;
}

/** True when the row shows a tick: this student has finished it at least once. */
export function isTaken(test: MockTestRow): boolean {
  return test.score !== null;
}

/**
 * The mock player's own URL, so Back works and a test can be shared
 * (DESIGN.md section 7).
 *
 * The mode and the topic ride in the QUERY, not the path: they are a choice
 * the student makes on the list, and the player in issues 17 and 18 reads them
 * rather than guessing.
 */
export function mockPlayerPath(
  teacherId: string,
  testId: string,
  options: { mode?: string; topicId?: string } = {},
): string {
  const base =
    `/t/${encodeURIComponent(teacherId)}/mocks/${encodeURIComponent(testId)}/play`;
  const query = new URLSearchParams();
  if (options.mode) query.set('mode', options.mode);
  // "Full paper" is the absence of a filter, so it is left out of the URL.
  if (options.topicId && options.topicId !== MOCK_TOPIC_ALL) {
    query.set('topic', options.topicId);
  }
  const tail = query.toString();
  return tail.length > 0 ? `${base}?${tail}` : base;
}

/**
 * The mock REVIEW route of a finished test: `/t/<id>/mocks/<id>/review`
 * (ticket 57c).
 *
 * The twin of `mockPlayerPath()`, and deliberately NOT the same URL. `play` is
 * the start route: opening it creates or resumes the `attempts` row. This one
 * only reads, so a taken row on the list points here and a student who looks
 * at an old test leaves nothing behind. Persona-1 gap 5 was exactly that: the
 * list's "Review" went to `play`, so every look started a sitting, and in exam
 * mode a timed one.
 *
 * NO MODE AND NO TOPIC. Those are a choice about a new sitting; the review
 * page reads the newest submitted sitting and takes the mode off the row, then
 * builds its own Retake link from it.
 */
export function mockReviewPath(teacherId: string, testId: string): string {
  return `/t/${encodeURIComponent(teacherId)}/mocks/${encodeURIComponent(testId)}/review`;
}

/** Rupees the way the dictionary writes them: "Rs 399" in English. */
export function rupees(priceInr: number, lang: 'en' | 'hi'): string {
  const whole = Number.isFinite(priceInr) ? Math.max(0, Math.round(priceInr)) : 0;
  return lang === 'hi' ? `₹${whole}` : `Rs ${whole}`;
}

/**
 * "Unlock Rs 399" per language line, so the button reads right in `both` mode
 * too (DESIGN.md section 1: English with Hindi under it).
 */
export function unlockLabels(priceInr: number, mode: LangMode): string[] {
  const words = labels('mockList.unlock', mode);
  const langs: ('en' | 'hi')[] = mode === 'both' ? ['en', 'hi'] : [mode];
  return words.map((word, index) => `${word} ${rupees(priceInr, langs[index] ?? 'en')}`);
}

/** The set header: the price, or "Unlocked" once it is paid for. */
export function priceLabels(set: MockSetRow, mode: LangMode): string[] {
  if (set.unlocked) return labels('mockList.unlocked', mode);
  const langs: ('en' | 'hi')[] = mode === 'both' ? ['en', 'hi'] : [mode];
  return langs.map((lang) => rupees(set.priceInr, lang));
}

/** Our own route the admin screen posts a grant to. Holds no key. */
export const ADMIN_SET_ACCESS_PATH = '/api/admin/set-access';

/** Shared by the route handler and the Supabase client. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface SetAccessClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** The SIGNED-IN user's own rows. A student never reads anybody else's. */
  listMine(): Promise<SetAccess[]>;
  /**
   * The caller's own last submitted sitting per test, for the tick and the
   * score. Lives here because the mock list needs it; the sittings themselves
   * are written by issue 17-practice-mode.
   */
  listScores(testIds: readonly string[]): Promise<TestScore[]>;
  /** Admin only, and the policy says so: grant a set by hand. */
  grant(input: GrantSetInput): Promise<void>;
  /** Admin only: end a grant now by deleting the row. */
  revoke(input: RevokeSetInput): Promise<void>;
}

/** Browser side. Calls our own route; never sees a Supabase key. */
export interface AdminSetAccessClient {
  grant(input: GrantSetInput): Promise<void>;
  revoke(input: RevokeSetInput): Promise<void>;
}
