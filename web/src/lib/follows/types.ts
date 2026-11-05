/**
 * The follow contract for PolityPedia (issue 06-portfolio-follow).
 *
 * Follow is FREE (PRD F-A2, renamed from Subscribe in v0), so nothing here
 * carries money, a plan or a date range. A follow is one (student, teacher)
 * pair and nothing else.
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call and no real key anywhere in the test suite (web/CLAUDE.md).
 *
 * Two kinds of client, because a key must never reach the browser:
 * - `FollowsClient` runs on the server with the signed-in student's own access
 *   token, so Postgres RLS (`follows_*_own`) is the real gate.
 * - `BrowserFollowsClient` calls our own route handler and never sees a key.
 */

/** The four tiles of a teacher portfolio (PRD F-A3, DESIGN.md section 8). */
export type TileSlug = 'videos' | 'papers' | 'mocks' | 'news';

export const TILE_SLUGS: readonly TileSlug[] = ['videos', 'papers', 'mocks', 'news'];

/** `/t/<id>` is the teacher portfolio URL. Every teacher page has its own. */
export function teacherPath(teacherId: string): string {
  return `/t/${teacherId}`;
}

export function tilePath(teacherId: string, slug: TileSlug): string {
  return `${teacherPath(teacherId)}/${slug}`;
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface FollowsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** Teacher ids the caller follows, newest first. Empty list on any failure. */
  listFollowing(): Promise<string[]>;
  /** Add the caller's own follow row. Idempotent: a double tap is not an error. */
  follow(teacherId: string): Promise<void>;
  /** Drop the caller's own follow row. */
  unfollow(teacherId: string): Promise<void>;
}

/** Browser side: the Follow button. Calls our own route. */
export interface BrowserFollowsClient {
  /** `following` is the state the student wants, not the state they came from. */
  setFollowing(teacherId: string, following: boolean): Promise<void>;
}
