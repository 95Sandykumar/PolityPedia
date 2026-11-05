/**
 * POST   /api/teacher/posts -> add one notice
 * DELETE /api/teacher/posts -> drop one notice
 * (issue 09-teacher-notifications).
 *
 * Thin adapter. Every rule lives in `@/lib/posts/posts-route`, which the tests
 * drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `teacher_posts_insert_own` and
 * `teacher_posts_delete_own` policies inside Postgres are the real gate. There
 * is no service-role key in this route, and the author never comes from the
 * body.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleCreatePost, handleDeletePost } from '@/lib/posts/posts-route';
import { createSupabaseTeacherPostsClient } from '@/lib/posts/supabase-posts-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

/** Both verbs need the same three lines, so they share them. */
async function run(
  request: Request,
  handle: typeof handleCreatePost | typeof handleDeletePost,
): Promise<NextResponse> {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: both handlers answer 400 for it.
  }

  const reply = await handle({
    body,
    session,
    client: createSupabaseTeacherPostsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}

export async function POST(request: Request) {
  return run(request, handleCreatePost);
}

export async function DELETE(request: Request) {
  return run(request, handleDeletePost);
}
