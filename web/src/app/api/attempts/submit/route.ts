/**
 * POST /api/attempts/submit -> close the caller's own sitting
 * (issue 13-question-player).
 *
 * Thin adapter. Every rule lives in `@/lib/attempts/attempts-route`.
 *
 * The call behind it is `score_attempt()` in Postgres, which marks the paper
 * from `questions.correct_idx` and closes the sitting (issue
 * 31-attempt-score-guard: a student's own PATCH of `score` is refused). It is
 * write-once, so a replayed request returns the stored score and cannot change
 * a number the student has already seen.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleSubmitAttempt } from '@/lib/attempts/attempts-route';
import { createSupabaseAttemptsClient } from '@/lib/attempts/supabase-attempts-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleSubmitAttempt({
    body,
    session,
    client: createSupabaseAttemptsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
