/**
 * POST /api/tests/<id>/answer -> store one answer of the caller's own timed
 * sitting (issue 18-exam-mode).
 *
 * Thin adapter. Every rule lives in `@/lib/exam/exam-route`.
 *
 * ITS OWN ROUTE, next to `/api/attempts/answers` from issue 13, for one
 * reason: an exam answer carries NO VERDICT. `readExamAnswer` has no field for
 * one, so a phone cannot mark its own paper even by sending a body it made up.
 * The practice route's reader still refuses a half answer, so neither route
 * had to be loosened for the other.
 *
 * A1: the write is an upsert keyed `(attempt_id, question_id)`, so the
 * player's retry queue may post the same answer twice. One row either way.
 *
 * THE CLOCK IS NOT CHECKED HERE. `attempt_answers_insert_open` and
 * `attempt_answers_update_open` in `0018_exam_mode.sql` refuse a late write
 * inside Postgres, so a student with a edited device clock, a stale tab or a
 * replayed queue writes nothing whatever this route believes the time is.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleExamAnswer } from '@/lib/exam/exam-route';
import { createSupabaseExamClient } from '@/lib/exam/supabase-exam-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleExamAnswer({
    body,
    session,
    client: createSupabaseExamClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
