/**
 * The decision logic behind /api/teacher/posts (issue 09-teacher-notifications).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `follows-route.ts` / its route.
 *
 * Order of checks: session, then role, then config, then the body.
 *
 * WHO the post belongs to is never in the body. It comes from the session, so
 * there is no field a caller could set to post in another teacher's name. Any
 * `teacherId` in the body is ignored.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `teacher_posts_insert_own` and `teacher_posts_delete_own` policies inside
 * Postgres. Replies carry a fixed message, so a policy name never reaches the
 * browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  DEFAULT_PRIORITY,
  isPriority,
  normalizeHeading,
  normalizeLink,
  type NewTeacherPost,
  type TeacherPost,
  type TeacherPostsClient,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostsInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: TeacherPostsClient;
}

export interface PostsReply {
  status: number;
  body: { ok: true } | { ok: true; post: TeacherPost } | { error: string };
}

function fail(status: number, error: string): PostsReply {
  return { status, body: { error } };
}

/**
 * Only an APPROVED teacher may write. Fails closed: a missing status is read
 * as pending, so an old cookie cannot post. Same rule as the middleware guard
 * for `/teacher/*` (issue 05), repeated here because a route is reachable
 * without ever loading a page.
 */
function mayPost(session: AuthSession): boolean {
  return session.role === 'teacher' && session.teacherStatus === 'approved';
}

function readNewPost(body: unknown): NewTeacherPost | null {
  if (typeof body !== 'object' || body === null) return null;
  const { heading, priority, link } = body as Record<string, unknown>;

  const cleanHeading = normalizeHeading(heading);
  if (cleanHeading === null) return null;

  // Missing means "normal". Anything present must be one of our three, so a
  // caller cannot invent a priority that sorts above urgent.
  const cleanPriority = priority === undefined ? DEFAULT_PRIORITY : priority;
  if (!isPriority(cleanPriority)) return null;

  // Missing or null means "no link". Anything else has to survive
  // `normalizeLink`, which is what keeps `javascript:` out of a student's page.
  let cleanLink: string | null = null;
  if (link !== undefined && link !== null) {
    cleanLink = normalizeLink(link);
    if (cleanLink === null) return null;
  }

  return { heading: cleanHeading, priority: cleanPriority, link: cleanLink };
}

function readPostId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { postId } = body as Record<string, unknown>;
  if (typeof postId !== 'string' || !UUID_RE.test(postId)) return null;
  return postId;
}

export async function handleCreatePost({
  body,
  session,
  client,
}: PostsInput): Promise<PostsReply> {
  if (!session) return fail(401, 'sign in');
  if (!mayPost(session)) return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const wanted = readNewPost(body);
  if (!wanted) return fail(400, 'bad request');

  let post: TeacherPost;
  try {
    // Three fields only. The author comes from the session inside the client.
    post = await client.create(wanted);
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  return { status: 201, body: { ok: true, post } };
}

export async function handleDeletePost({
  body,
  session,
  client,
}: PostsInput): Promise<PostsReply> {
  if (!session) return fail(401, 'sign in');
  if (!mayPost(session)) return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const postId = readPostId(body);
  if (!postId) return fail(400, 'bad request');

  try {
    await client.remove(postId);
  } catch {
    return fail(502, 'save failed');
  }

  return { status: 200, body: { ok: true } };
}
