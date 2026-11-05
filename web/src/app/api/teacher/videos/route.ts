/**
 * POST /api/teacher/videos -> add a link, remove a row, or flip Show / No show
 * (issue 08-videos-tile).
 *
 * Thin adapter. Every rule lives in `@/lib/videos/videos-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the TEACHER'S OWN access token and user id out of
 * the httpOnly session cookie, so the `teacher_videos_*_own` policies inside
 * Postgres are the real gate. There is no service-role key in this route, and
 * the row owner never comes from the body.
 *
 * The YouTube call is the keyless oEmbed endpoint and runs on the server, so
 * no key exists to leak and the student's browser never talks to YouTube until
 * they tap a thumbnail.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { readSessionCookie } from '@/lib/teachers/read-session';
import { createOEmbedVideoMeta } from '@/lib/videos/oembed-video-meta';
import { createSupabaseVideosClient } from '@/lib/videos/supabase-videos-client';
import { handleTeacherVideos } from '@/lib/videos/videos-route';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleTeacherVideos` answers 400 for it.
  }

  const reply = await handleTeacherVideos({
    body,
    session,
    client: createSupabaseVideosClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
    meta: createOEmbedVideoMeta(),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
