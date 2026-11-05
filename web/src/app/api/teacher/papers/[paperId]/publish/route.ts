/**
 * POST /api/teacher/papers/<paperId>/publish -> the paper and its questions go
 * live (issue 11-ingest-job-review-publish).
 *
 * Thin adapter. Every rule lives in `@/lib/questions/questions-route`, which
 * the tests drive directly.
 *
 * This is the ONLY door to `publish_paper()`, and that function is where V9
 * lives: it refuses while the split job still runs, and it refuses while one
 * question is unchecked. The greyed-out button on the review screen is a
 * courtesy; this is the rule.
 *
 * POST and not GET, because it changes the world: a prefetch or a crawler must
 * never be able to publish a paper.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reply is
 * one short word, never a Postgres message.
 */
import { NextResponse } from 'next/server';
import { handlePublishPaper } from '@/lib/questions/questions-route';
import { createSupabaseQuestionsClient } from '@/lib/questions/supabase-questions-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ paperId: string }> },
) {
  const session = readSessionCookie(request);
  const { paperId } = await params;

  const reply = await handlePublishPaper({
    paperId,
    session,
    client: createSupabaseQuestionsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
