/**
 * POST /api/saved -> save or remove one tag on one question, for the caller
 * only (issue 14-saved-list).
 *
 * Thin adapter. Every rule lives in `@/lib/saved/saved-route`, which the tests
 * drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token and user id out of
 * the httpOnly session cookie, so the `saved_questions_*_own` policies inside
 * Postgres are the real gate. There is no service-role key in this route, and
 * the row owner never comes from the body.
 *
 * The write is an upsert keyed `(user_id, question_id, tag)`, so the player may
 * post the same `wrong` tag on every tap. One row either way.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleSaved } from '@/lib/saved/saved-route';
import { createSupabaseSavedClient } from '@/lib/saved/supabase-saved-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleSaved({
    body,
    session,
    client: createSupabaseSavedClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
