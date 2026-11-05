/**
 * POST /api/teacher/mock-sets/<setId>/tests -> add one test to the caller's
 * own mock set (issue 15-mock-sets-authoring).
 *
 * Thin adapter. Every rule lives in `@/lib/mocks/mocks-route`, which the tests
 * drive directly.
 *
 * THE SET ID COMES FROM THE PATH, never from the body. A body is editable in
 * a browser console; the path is what this route reads and hands to a client
 * that checks the uuid shape before building a URL. The real gate is still
 * `mock_tests_insert_own`, which asks Postgres whether the parent set belongs
 * to the caller.
 *
 * V11: only Test 1 may be the free sample. The handler answers 400, the client
 * refuses before the request, and `mock_tests_free_sample_check` would refuse
 * the row even if both were wrong.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handleSaveMockTest } from '@/lib/mocks/mocks-route';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ setId: string }> },
) {
  const session = readSessionCookie(request);
  const { setId } = await params;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleSaveMockTest({
    setId,
    body,
    session,
    client: createSupabaseMocksClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
