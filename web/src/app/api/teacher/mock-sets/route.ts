/**
 * POST /api/teacher/mock-sets -> create or reprice one of the caller's own
 * mock sets (issue 15-mock-sets-authoring).
 *
 * Thin adapter. Every rule lives in `@/lib/mocks/mocks-route`, which the tests
 * drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `mock_sets_insert_own` and
 * `mock_sets_update_own` policies inside Postgres are the real gate. There is
 * no service-role key in this route, and the row owner never comes from the
 * body.
 *
 * V11: this route cannot price a set outside Rs 299 to Rs 399. The handler
 * answers 400, the client refuses before the request, and
 * `mock_sets_price_check` would refuse the row even if both were wrong.
 *
 * V9: this route cannot publish anything. A set goes live only through
 * `publish_mock_set()`.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleSaveMockSet } from '@/lib/mocks/mocks-route';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: the handler answers 400 for a body it cannot read.
  }

  const reply = await handleSaveMockSet({
    body,
    session,
    client: createSupabaseMocksClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
