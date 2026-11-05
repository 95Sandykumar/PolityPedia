/**
 * POST /api/tests/<id>/submit -> the SERVER marks the paper and closes the
 * sitting (issue 18-exam-mode).
 *
 * Thin adapter. Every rule lives in `@/lib/exam/exam-route`.
 *
 * THE SCORE IS NOT IN THE BODY. Issue 13's submit route takes a score the
 * player worked out, because practice mode marks every answer as it is given.
 * A timed sitting cannot: the phone was never handed `correct_idx` (F-E5). So
 * this route sends ONE id to `score_attempt()`, which reads the key inside
 * Postgres, marks with the exam's scheme (F-E6), writes `submitted_at` and
 * `score` once, and hands back the number.
 *
 * SAFE TO CALL TWICE. `score_attempt()` returns the STORED score for a sitting
 * that is already closed, so a retry after a dropped reply on 4G gives the
 * same number and marks nothing again. That also means the auto-submit when
 * the clock hits zero and a student's own tap on Submit cannot disagree.
 *
 * POST and not GET, because it changes the world: a prefetch or a crawler must
 * never be able to end a student's exam.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word plus a number, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handleExamSubmit } from '@/lib/exam/exam-route';
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

  const reply = await handleExamSubmit({
    body,
    session,
    client: createSupabaseExamClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
