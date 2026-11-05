/**
 * PATCH /api/teacher/explanations -> correct one AI explanation
 * (issue 24-revision-teacher-edit).
 *
 * Thin adapter. Every rule lives in `@/lib/ai/teacher-edit-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `ai_explanations_update_owner` policy
 * and the `ai_explanations_teacher_edit` trigger inside Postgres are the real
 * gate. There is no service-role key in this route, and WHO is editing never
 * comes from the body.
 *
 * PATCH, not POST: this changes one field of a row that already exists.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleEditExplanation } from '@/lib/ai/teacher-edit-route';
import { createSupabaseTeacherExplanationsClient } from '@/lib/ai/supabase-teacher-explanations-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function PATCH(request: Request): Promise<NextResponse> {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for it.
  }

  const reply = await handleEditExplanation({
    body,
    session,
    client: createSupabaseTeacherExplanationsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
