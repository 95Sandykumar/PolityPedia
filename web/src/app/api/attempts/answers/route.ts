/**
 * POST /api/attempts/answers -> store one answer of the caller's own sitting
 * (issue 13-question-player).
 *
 * Thin adapter. Every rule lives in `@/lib/attempts/attempts-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token and user id out of
 * the httpOnly session cookie, so the `attempt_answers_*` policies inside
 * Postgres are the real gate. There is no service-role key in this route, and
 * the attempt owner never comes from the body.
 *
 * A1: the write is an upsert keyed `(attempt_id, question_id)`, so the
 * player's retry queue may post the same answer twice. One row either way.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleSaveAnswer } from '@/lib/attempts/attempts-route';
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

  const reply = await handleSaveAnswer({
    body,
    session,
    client: createSupabaseAttemptsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
