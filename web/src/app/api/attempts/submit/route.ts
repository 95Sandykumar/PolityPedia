/**
 * POST /api/attempts/submit -> close the caller's own sitting
 * (issue 13-question-player).
 *
 * Thin adapter. Every rule lives in `@/lib/attempts/attempts-route`.
 *
 * The PATCH behind it matches `submitted_at is null`, so a submit is
 * write-once: a replayed request moves no row and cannot change a score the
 * student has already seen.
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
