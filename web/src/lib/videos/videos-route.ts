/**
 * The decision logic behind POST /api/teacher/videos (issue 08-videos-tile).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `follows-route.ts` / its route.
 *
 * Three actions on one route, because they are one screen:
 *   { action: 'add',     url: '<any YouTube link>' }
 *   { action: 'remove',  id: '<uuid>' }
 *   { action: 'visible', visible: true | false }    <- V6, PRD F-C2
 *
 * Order of checks: session, then role, then config, then the body.
 *
 * WHO the row belongs to is never in the body. It comes from the session, so
 * there is no field a caller could set to post a video onto another teacher's
 * portfolio.
 *
 * The link is parsed HERE, on the server, with the same `parseYouTubeId` the
 * page uses. V6 says YouTube only, so a link we cannot read is a 400 and
 * nothing is stored.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `teacher_videos_*_own` policies and the `youtube_id` check constraint inside
 * Postgres. Replies carry a fixed message, so a policy name never reaches the
 * browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { parseYouTubeId, youTubeThumbUrl } from './youtube-url';
import type { VideoMeta, VideosClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest text we will even try to parse as a link. */
const MAX_URL_LENGTH = 2_000;

export interface TeacherVideosInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: VideosClient;
  /** Reads the title from YouTube. Faked in tests. */
  meta: VideoMeta;
}

export interface TeacherVideosReply {
  status: number;
  body: { ok: true; visible?: boolean } | { error: string };
}

function fail(status: number, error: string): TeacherVideosReply {
  return { status, body: { error } };
}

type Wanted =
  | { action: 'add'; youtubeId: string }
  | { action: 'remove'; id: string }
  | { action: 'visible'; visible: boolean };

function readBody(body: unknown): Wanted | null {
  if (typeof body !== 'object' || body === null) return null;
  const { action, url, id, visible } = body as Record<string, unknown>;

  if (action === 'add') {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
    // One parser for the whole app. V6: nothing but a YouTube link gets in.
    const youtubeId = parseYouTubeId(url);
    return youtubeId === null ? null : { action: 'add', youtubeId };
  }

  if (action === 'remove') {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    return { action: 'remove', id };
  }

  if (action === 'visible') {
    // A boolean, not a truthy value: "false" as a string must not read as true.
    if (typeof visible !== 'boolean') return null;
    return { action: 'visible', visible };
  }

  return null;
}

export async function handleTeacherVideos({
  body,
  session,
  client,
  meta,
}: TeacherVideosInput): Promise<TeacherVideosReply> {
  if (!session) return fail(401, 'sign in');
  // A student has no business here. An admin may act, like every other
  // teacher screen (the rank in guard.ts).
  if (session.role !== 'teacher' && session.role !== 'admin') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const wanted = readBody(body);
  if (!wanted) return fail(400, 'bad request');

  try {
    if (wanted.action === 'add') {
      // The title is a nicety, so it is read BEFORE the write but never
      // allowed to stop it: `readTitle` answers null instead of throwing.
      const [title, mine] = await Promise.all([
        meta.readTitle(wanted.youtubeId),
        client.listMine(),
      ]);

      await client.add({
        youtubeId: wanted.youtubeId,
        title,
        thumbUrl: youTubeThumbUrl(wanted.youtubeId),
        // New links go to the end, so the teacher's order is not reshuffled.
        position: mine.length,
      });
      return { status: 200, body: { ok: true } };
    }

    if (wanted.action === 'remove') {
      await client.remove(wanted.id);
      return { status: 200, body: { ok: true } };
    }

    await client.setVisible(wanted.visible);
    // Echo the state back, so the switch and the server cannot drift apart.
    return { status: 200, body: { ok: true, visible: wanted.visible } };
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }
}
