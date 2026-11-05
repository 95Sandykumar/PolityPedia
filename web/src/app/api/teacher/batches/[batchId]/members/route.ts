/**
 * POST /api/teacher/batches/<batchId>/members -> remove one student from the
 * caller's own batch (issue 19-batches, V2 "Teacher can remove a student").
 *
 * Thin adapter. Every rule lives in `@/lib/batches/batches-route`, which the
 * tests drive directly.
 *
 * THE BATCH ID COMES FROM THE PATH, never from the body. A body is editable in
 * a browser console; the path is what this route reads and hands to a client
 * that checks the uuid shape before building a URL. The real gate is still
 * `batch_members_delete_own_or_teacher`, which asks Postgres whether the batch
 * belongs to the caller.
 *
 * THERE IS NO ADD HERE. A student gets in through `join_batch()` with the
 * code, and `batch_members` has no INSERT policy at all, so no route can put
 * somebody in a batch they were not invited to.
 *
 * Revoking the batch's free sets is NOT this route's job: the trigger in
 * `0019_batches.sql` does it in the same transaction as the delete.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handleRemoveMember } from '@/lib/batches/batches-route';
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

  const reply = await handleRemoveMember({
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
