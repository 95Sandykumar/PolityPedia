/**
 * The reads the three post screens of this slice share
 * (issue 09-teacher-notifications): `/t/<id>/news`, Home, and the teacher's
 * own notice board.
 *
 * Server only. Every read runs HERE, on the server, with the caller's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides the
 * rows and the browser never holds a key. The same shape as
 * `@/lib/follows/student-page`.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT: a Supabase hiccup never 500s a tab. What it does NOT
 * do any more is lie. Each read comes in a `*Result` flavour that tells an
 * empty read from a failed one (issue 54b-read-errors-home-teachers), so Home
 * shows the shared error state instead of "No notices yet" and a portfolio
 * tile shows no number instead of a confident 0.
 */
import type { AuthSession } from '@/lib/auth/types';
import { readOk, readWithProbe, type ReadResult } from '@/lib/read-result';
import type { PublicTeacher } from '@/lib/teachers/types';
import { createSupabaseTeacherPostsClient } from './supabase-posts-client';
import { MAX_HOME_POSTS, homeFeed, type FeedPost, type TeacherPost } from './types';

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface PostsReadOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function postsClient(
  session: AuthSession | null,
  options: PostsReadOptions = {},
  fetchImpl?: typeof fetch,
) {
  return createSupabaseTeacherPostsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
    ...(options.env ? { env: options.env } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * One teacher's notices, and whether the read worked.
 *
 * The query is the same query as before: the same `listForTeacher` call on the
 * same client, so the same columns and the same order. The only new thing is a
 * probe handed to the client in place of `fetch`, which remembers a non-ok
 * status on the way past. The client still turns a 400 into `[]` inside itself;
 * the probe is what lets the reader know it happened.
 */
export async function readTeacherPostsResult(
  session: AuthSession | null,
  teacherId: string,
  options: PostsReadOptions = {},
): Promise<ReadResult<TeacherPost[]>> {
  // Signed out is not broken: there is nothing to read, so it is an OK empty
  // read and the screen keeps its empty state.
  if (!session) return readOk<TeacherPost[]>([]);

  return readWithProbe(
    (fetchImpl) =>
      postsClient(session, options, fetchImpl)
        .listForTeacher(teacherId)
        .catch(() => [] as TeacherPost[]),
    options.fetchImpl,
  );
}

/** One teacher's notices, for callers that have no error state yet. */
export async function readTeacherPosts(
  session: AuthSession | null,
  teacherId: string,
): Promise<TeacherPost[]> {
  const read = await readTeacherPostsResult(session, teacherId);
  return read.ok ? read.data : [];
}

/**
 * The Home feed: the latest notices from the teachers this student FOLLOWS.
 *
 * The followed list is passed in, because Home has already read it for the
 * teacher list, and it is also the FILTER: `homeFeed` drops a post from
 * anybody who is not on it. So even if the query came back wider than asked,
 * Home cannot show a stranger's notice.
 */
export async function readHomePostsResult(
  session: AuthSession | null,
  teachers: readonly PublicTeacher[],
  options: PostsReadOptions & { limit?: number } = {},
): Promise<ReadResult<FeedPost[]>> {
  const limit = options.limit ?? MAX_HOME_POSTS;
  // No followed teachers is not a failure: there is nothing to ask for, so no
  // request goes out and Home keeps its "follow somebody" empty state.
  if (!session || teachers.length === 0) return readOk<FeedPost[]>([]);

  return readWithProbe(async (fetchImpl) => {
    const posts = await postsClient(session, options, fetchImpl)
      .listForTeachers(
        teachers.map((teacher) => teacher.userId),
        limit,
      )
      .catch(() => [] as TeacherPost[]);

    return homeFeed({ teachers, posts, limit });
  }, options.fetchImpl);
}

/** The Home feed, for callers that have no error state yet. */
export async function readHomePosts(
  session: AuthSession | null,
  teachers: readonly PublicTeacher[],
  limit: number = MAX_HOME_POSTS,
): Promise<FeedPost[]> {
  const read = await readHomePostsResult(session, teachers, { limit });
  return read.ok ? read.data : [];
}

/** The caller's own notices, for the teacher notice board. */
export async function readMyPosts(session: AuthSession | null): Promise<TeacherPost[]> {
  return postsClient(session)
    .listMine()
    .catch(() => []);
}
