/**
 * POST /api/batches/join -> a student trades a join code for a membership
 * (issue 19-batches, V2 "Student joins by link or code").
 *
 * Thin adapter. Every rule lives in `@/lib/batches/batches-route`, which the
 * tests drive directly.
 *
 * A STUDENT ROUTE, not a teacher one. It sits under `/api/batches` and not
 * `/api/teacher/batches` so that is obvious from the path, and the handler
 * asks for a session and nothing more.
 *
 * The Supabase call carries the STUDENT'S OWN access token out of the httpOnly
 * session cookie, so `join_batch()` reads their real `auth.uid()` and writes
 * the membership for THEM. There is no user id in the body, so there is no
 * field a caller could set to put somebody else in a batch.
 *
 * The code is the capability. `batch_members` has no INSERT policy, so this
 * route plus the code is the only way in, and a 404 says "bad code" in the
 * same words as a 400: a student does not need to be told which, and telling
 * them would turn this route into a tool for guessing other teachers' codes.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handleJoinBatch } from '@/lib/batches/batches-route';
import { createSupabaseBatchesClient } from '@/lib/batches/supabase-batches-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleJoinBatch({
    body,
    session,
    client: createSupabaseBatchesClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
