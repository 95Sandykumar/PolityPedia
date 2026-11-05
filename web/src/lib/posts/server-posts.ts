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
 * Every read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 on the Home tab.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { PublicTeacher } from '@/lib/teachers/types';
import { createSupabaseTeacherPostsClient } from './supabase-posts-client';
import { MAX_HOME_POSTS, homeFeed, type FeedPost, type TeacherPost } from './types';

function postsClient(session: AuthSession | null) {
  return createSupabaseTeacherPostsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/** One teacher's notices, for the Notifications tile `/t/<id>/news`. */
export async function readTeacherPosts(
  session: AuthSession | null,
  teacherId: string,
): Promise<TeacherPost[]> {
  return postsClient(session)
    .listForTeacher(teacherId)
    .catch(() => []);
}

/**
 * The Home feed: the latest notices from the teachers this student FOLLOWS.
 *
 * The followed list is passed in, because Home has already read it for the
 * teacher list, and it is also the FILTER: `homeFeed` drops a post from
 * anybody who is not on it. So even if the query came back wider than asked,
 * Home cannot show a stranger's notice.
 */
export async function readHomePosts(
  session: AuthSession | null,
  teachers: readonly PublicTeacher[],
  limit: number = MAX_HOME_POSTS,
): Promise<FeedPost[]> {
  if (teachers.length === 0) return [];

  const posts = await postsClient(session)
    .listForTeachers(
      teachers.map((teacher) => teacher.userId),
      limit,
    )
    .catch(() => [] as TeacherPost[]);

  return homeFeed({ teachers, posts, limit });
}

/** The caller's own notices, for the teacher notice board. */
export async function readMyPosts(session: AuthSession | null): Promise<TeacherPost[]> {
  return postsClient(session)
    .listMine()
    .catch(() => []);
}
