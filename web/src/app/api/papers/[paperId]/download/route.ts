/**
 * GET /api/papers/<paperId>/download?kind=questions -> the PDF
 * (issue 10-papers-upload-browse).
 *
 * Thin adapter. Every rule lives in `@/lib/papers/papers-route`, which the
 * tests drive directly.
 *
 * Why a route and not a link straight to Storage: the bucket is private, so a
 * student needs a SIGNED url, and a signed url is only safe to mint after the
 * `papers_select_live` policy has agreed the caller may see that paper. Both
 * reads here carry the caller's own access token, so Postgres decides first
 * and the link we hand back dies a minute later.
 *
 * Security: nothing here is logged, and the redirect is the only thing that
 * leaves. A missing paper, a draft of somebody else's and a missing file all
 * answer 404, so the reply never says which one it was.
 */
import { NextResponse } from 'next/server';
import { handlePaperDownload } from '@/lib/papers/papers-route';
import { createSupabaseFileStore } from '@/lib/papers/supabase-file-store';
import { createSupabasePapersClient } from '@/lib/papers/supabase-papers-client';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ paperId: string }> },
) {
  const session = readSessionCookie(request);
  const { paperId } = await params;

  const reply = await handlePaperDownload({
    paperId,
    kind: new URL(request.url).searchParams.get('kind'),
    session,
    client: createSupabasePapersClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
    store: createSupabaseFileStore({ accessToken: session?.accessToken ?? '' }),
  });

  if (reply.status === 302 && reply.url) {
    // 302, not 307: this is a plain GET, there is no body to re-send, and the
    // signed link is good for one minute, so it must never be cached.
    return NextResponse.redirect(reply.url, {
      status: 302,
      headers: { 'cache-control': 'no-store' },
    });
  }

  return NextResponse.json(reply.body ?? { error: 'not found' }, { status: reply.status });
}
