/**
 * POST /api/teacher/batches -> create or rename one of the caller's own
 * batches (issue 19-batches).
 *
 * Thin adapter. Every rule lives in `@/lib/batches/batches-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `batches_insert_own` and
 * `batches_update_own` policies inside Postgres are the real gate. There is no
 * service-role key in this route, and the row owner never comes from the body.
 *
 * This route cannot choose a join code. `new_join_code()` is the column
 * default, so a caller cannot point a new batch at a code they want to guess.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleSaveBatch } from '@/lib/batches/batches-route';
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

  const reply = await handleSaveBatch({
    body,
    session,
    client: createSupabaseBatchesClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
