/**
 * POST /api/teacher/exams -> replace the caller's own next exam dates
 * (issue 07-next-exam-date-teacher-shell).
 *
 * Thin adapter. Every rule lives in `@/lib/teacher-exams/teacher-exams-route`,
 * which the tests drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `teacher_exams_insert_own`,
 * `_update_own` and `_delete_own` policies inside Postgres are the real gate.
 * There is no service-role key in this route, and the row owner never comes
 * from the body.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { createSupabaseTeacherExamsClient } from '@/lib/teacher-exams/supabase-teacher-exams-client';
import { handleTeacherExams } from '@/lib/teacher-exams/teacher-exams-route';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleTeacherExams` answers 400 for it.
  }

  const reply = await handleTeacherExams({
    body,
    session,
    client: createSupabaseTeacherExamsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
