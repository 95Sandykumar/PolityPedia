/**
 * POST /api/teacher/mock-sets/<setId>/publish -> the set and its questions go
 * live (issue 15-mock-sets-authoring).
 *
 * Thin adapter. Every rule lives in `@/lib/mocks/mocks-route`, which the tests
 * drive directly.
 *
 * This is the ONLY door to `publish_mock_set()`, and that function is where
 * the rules live: it refuses a set with no tests, it refuses while one
 * question is unchecked (V9), and it refuses somebody else's set. The
 * greyed-out button on the authoring screen is a courtesy; this is the rule.
 *
 * POST and not GET, because it changes the world: a prefetch or a crawler must
 * never be able to put a paid product on sale.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handlePublishMockSet } from '@/lib/mocks/mocks-route';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ setId: string }> },
) {
  const session = readSessionCookie(request);
  const { setId } = await params;

  const reply = await handlePublishMockSet({
    setId,
    session,
    client: createSupabaseMocksClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
