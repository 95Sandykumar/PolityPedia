/**
 * The teacher-posts contract for PolityPedia (issue 09-teacher-notifications).
 *
 * V17 / PRD F-H1: a teacher posts a notice (priority, heading, link) and it
 * shows at the TOP of the Notifications tile. The nightly news from v0 goes
 * below these in a later slice.
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call and no real key anywhere in the test suite (web/CLAUDE.md).
 *
 * Two kinds of client, because a key must never reach the browser:
 * - `TeacherPostsClient` runs on the server with the signed-in caller's own
 *   access token, so Postgres RLS (`teacher_posts_*`) is the real gate.
 * - `BrowserTeacherPostsClient` calls our own route handler and never sees a
 *   key.
 *
 * The ORDER and the HOME FILTER are pure functions here, not SQL that each
 * page writes its own way, so every screen answers the question the same way
 * and `posts-order.test.ts` can prove it once.
 */

/** 0 normal, 1 important, 2 urgent. Mirrors the SQL check in 0009. */
export const PRIORITIES = [0, 1, 2] as const;

export type Priority = (typeof PRIORITIES)[number];

/** Default when a teacher does not pick: a plain notice. */
export const DEFAULT_PRIORITY: Priority = 0;

/** One line, not a paragraph (DESIGN.md section 1). Mirrors the SQL check. */
export const MAX_HEADING_LENGTH = 200;

/** V17: Home is a glance, not an archive. The issue asks for the latest 5. */
export const MAX_HOME_POSTS = 5;

/** `/t/<id>/news` is the Notifications tile of a teacher portfolio. */
export const NEWS_SLUG = 'news';

/** The teacher's own notice board. Behind the `/teacher` role guard. */
export const TEACHER_POSTS_PATH = '/teacher/posts';

export function isPriority(value: unknown): value is Priority {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (PRIORITIES as readonly number[]).includes(value)
  );
}

/** Trim it, then refuse a blank or an over-long one. Null means "no". */
export function normalizeHeading(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADING_LENGTH) return null;
  return trimmed;
}

/**
 * http and https only. Null for everything else, including a blank string.
 *
 * This is a SECURITY check, not tidiness: the value becomes an `href` in a
 * student's page, so `javascript:` or `data:` would be a script waiting for a
 * tap. A scheme-less value like `nta.ac.in` is refused too, because the
 * browser would read it as a path on our own site. Postgres repeats the same
 * check in `0009_teacher_posts.sql`.
 */
export function normalizeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  return trimmed;
}

/** One row of `public.teacher_posts`. */
export interface TeacherPost {
  id: string;
  teacherId: string;
  priority: number;
  heading: string;
  /** Null, or an http(s) URL. Never any other scheme: see `normalizeLink`. */
  link: string | null;
  /** ISO timestamp, as Postgres handed it over. */
  createdAt: string;
}

/** A post plus its author's display name, for Home where teachers mix. */
export interface FeedPost extends TeacherPost {
  teacherName: string;
}

/** What a teacher types in. The author is never in here: it is the session. */
export interface NewTeacherPost {
  heading: string;
  priority: number;
  link: string | null;
}

/**
 * The ONE order rule: highest priority first, then newest first (V17).
 *
 * Postgres orders the same way and that is what the index is for, but a page
 * sorts again anyway, so a response that arrives in another order still paints
 * right. Returns a new array; the input is left alone.
 */
export function sortPosts<T extends { priority: number; createdAt: string }>(
  posts: readonly T[],
): T[] {
  return [...posts].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return time(b.createdAt) - time(a.createdAt);
  });
}

/** An unreadable date sorts oldest instead of throwing or poisoning the sort. */
function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Just enough of a teacher to label a post. A `PublicTeacher` fits. */
export interface PostAuthor {
  userId: string;
  displayName: string;
}

/**
 * The Home feed: the latest posts from the teachers this student FOLLOWS.
 *
 * `teachers` is the followed list, so it is also the filter: a post from
 * anybody else is dropped, even if it somehow arrived in `posts`. That is the
 * proof the issue asks for ("Home shows posts only from followed teachers"),
 * decided in one place instead of trusted to a query string.
 */
export function homeFeed({
  teachers,
  posts,
  limit = MAX_HOME_POSTS,
}: {
  teachers: readonly PostAuthor[];
  posts: readonly TeacherPost[];
  limit?: number;
}): FeedPost[] {
  const names = new Map(teachers.map((teacher) => [teacher.userId, teacher.displayName]));

  const mine: FeedPost[] = [];
  for (const post of posts) {
    const teacherName = names.get(post.teacherId);
    if (teacherName === undefined) continue;
    mine.push({ ...post, teacherName });
  }

  return sortPosts(mine).slice(0, Math.max(0, limit));
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface TeacherPostsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** One teacher's posts, in order. Empty list on any failure. */
  listForTeacher(teacherId: string): Promise<TeacherPost[]>;
  /** Several teachers' posts in one request, in order, capped at `limit`. */
  listForTeachers(teacherIds: readonly string[], limit: number): Promise<TeacherPost[]>;
  /** The caller's own posts, for their notice board. */
  listMine(): Promise<TeacherPost[]>;
  /** Add one post of the caller's own. Returns the STORED row (real id, date). */
  create(input: NewTeacherPost): Promise<TeacherPost>;
  /** Drop one post of the caller's own. */
  remove(postId: string): Promise<void>;
}

/** Browser side: the teacher's notice board. Calls our own route. */
export interface BrowserTeacherPostsClient {
  create(input: NewTeacherPost): Promise<TeacherPost>;
  remove(postId: string): Promise<void>;
}
