/**
 * POST /api/teacher/batches/<batchId>/sets -> one of the caller's own mock
 * sets becomes free for this batch, or stops being free
 * (issue 19-batches, V3).
 *
 * Thin adapter. Every rule lives in `@/lib/batches/batches-route`, which the
 * tests drive directly.
 *
 * THE BATCH ID COMES FROM THE PATH, never from the body, for the same reason
 * as the members route. The real gate is `batch_sets_insert_own`, which asks
 * Postgres two questions: is this batch yours, AND is this set yours. Giving
 * away another teacher's Rs 399 set would be taking money out of their pocket,
 * so owning the batch alone is not enough.
 *
 * Writing `set_access` is NOT this route's job: the trigger in
 * `0019_batches.sql` opens the set for every member of the batch, in the same
 * transaction, the moment the row lands.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handleSetBatchSet } from '@/lib/batches/batches-route';
import { createSupabaseBatchesClient } from '@/lib/batches/supabase-batches-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const session = readSessionCookie(request);
  const { batchId } = await params;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleSetBatchSet({
    batchId,
    body,
    session,
    client: createSupabaseBatchesClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
