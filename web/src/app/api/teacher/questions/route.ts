/**
 * POST /api/teacher/questions -> store one question of the caller's own
 * (issue 11-ingest-job-review-publish).
 *
 * Thin adapter. Every rule lives in `@/lib/questions/questions-route`, which
 * the tests drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `questions_insert_own` and
 * `questions_update_own` policies inside Postgres are the real gate. There is
 * no service-role key in this route, and the row owner never comes from the
 * body.
 *
 * V9: this route cannot publish anything. A question goes live only through
 * `publish_paper()`, and `questions_live_is_checked_check` would refuse a live
 * unchecked row even if it tried.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleSaveQuestion } from '@/lib/questions/questions-route';
import { createSupabaseQuestionsClient } from '@/lib/questions/supabase-questions-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleSaveQuestion({
    body,
    session,
    client: createSupabaseQuestionsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
