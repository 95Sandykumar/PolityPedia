/**
 * Teacher > Notices: add and delete notification posts
 * (issue 09-teacher-notifications).
 *
 * The middleware already keeps non-teachers out of `/teacher/*`, and sends a
 * teacher who is not approved yet to `/teacher/pending` (issue 05). This page
 * therefore only ever renders for an approved teacher, and the route handler
 * plus the `teacher_posts_*` policies check it again anyway.
 *
 * The list is read HERE, on the server, with the teacher's own access token
 * out of the httpOnly session cookie, so Postgres RLS decides the rows. The
 * browser never holds a key.
 *
 * `readStudentContext` is reused for the session plus the saved language: it
 * reads `profiles.lang`, which every role has, so a teacher sees their own
 * labels in their own language like everybody else.
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { TeacherPostsManager } from '@/components/teacher-posts-manager';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMyPosts } from '@/lib/posts/server-posts';
import type { TeacherPost } from '@/lib/posts/types';

export default async function TeacherPostsPage() {
  const { session, configured, mode } = await readStudentContext();
  const posts: TeacherPost[] = configured ? await readMyPosts(session) : [];

  // The page frame (nav, gutter, `<main>`) comes from `(dashboard)/layout.tsx`.
  return <TeacherPostsManager posts={posts} mode={mode} configured={configured} />;
}
