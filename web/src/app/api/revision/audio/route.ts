/**
 * GET /api/revision/audio?question_id=...&lang=en -> the explanation audio
 * (issue 25-revision-audio)
 *
 * Replies:
 *   302 to a short-lived signed Supabase URL (the bytes come from there)
 *   404 no audio yet, or the row is not readable
 *   401 not signed in
 *
 * Thin adapter. Every rule lives in `@/lib/ai/audio-route`, which the tests
 * drive directly.
 *
 * The Supabase calls carry the STUDENT'S OWN access token out of the httpOnly
 * session cookie, so the `ai_explanations_select_visible` policy from 0022
 * and the bucket's own storage policies are the real gate. There is no
 * service-role key in this route.
 *
 * `no-store`: a signed URL dies after an hour, so a cached redirect would
 * hand a student a dead link tomorrow.
 *
 * Security: nothing here is logged. The cookie holds tokens and the signed
 * URL is a bearer credential for the file.
 */
import { NextResponse } from 'next/server';
import { handleAudioUrl } from '@/lib/ai/audio-route';
import { createSupabaseAiClient } from '@/lib/ai/supabase-ai-client';
import { createSupabaseAudioStore } from '@/lib/ai/supabase-audio-store';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
/** A signed URL is never cached and never statically analysed. */
export const dynamic = 'force-dynamic';

/** Read our one session cookie off the raw header. Never throws. */
function readSession(request: Request): AuthSession | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    return decodeSession(part.slice(at + 1).trim());
  }
  return null;
}

export async function GET(request: Request) {
  const session = readSession(request);
  const accessToken = session?.accessToken ?? '';

  const reply = await handleAudioUrl({
    params: new URL(request.url).searchParams,
    session,
    client: createSupabaseAiClient({ accessToken }),
    store: createSupabaseAudioStore({ accessToken }),
  });

  if (reply.kind === 'play') {
    // 302, not 307: the player only ever sends GET, and a plain Found is what
    // every `<audio>` element on an old Android browser follows.
    return new NextResponse(null, {
      status: 302,
      headers: { location: reply.location, 'cache-control': 'no-store' },
    });
  }

  return NextResponse.json(
    { error: reply.error },
    { status: reply.status, headers: { 'cache-control': 'no-store' } },
  );
}
