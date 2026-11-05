/**
 * Server-side VideosClient over the Supabase REST API (issue 08-videos-tile).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `teacher_videos_*_own` policies for a teacher and
 * `teacher_videos_select_visible` for a student (0008_videos.sql).
 *
 * THE SHOW / NO SHOW RULE is not in this file. `listForTeacher` sends the same
 * request whether the teacher is on Show or No show; Postgres answers with 0
 * rows for No show. Keeping the rule in one place (SQL) is the point.
 *
 * `userId` is passed in from the session cookie, never from a request body,
 * because `teacher_videos.teacher_id` is the row owner.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { isValidYouTubeId } from './youtube-url';
import type { AddVideoInput, TeacherVideo, VideosClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/teacher_videos';
const TEACHERS = '/rest/v1/teachers';

/** Never `select=*`, so a column added later cannot leak by accident. */
const COLUMNS = 'id,teacher_id,youtube_id,title,thumb_url,position';

export interface SupabaseVideosClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface VideoRow {
  id?: unknown;
  teacher_id?: unknown;
  youtube_id?: unknown;
  title?: unknown;
  thumb_url?: unknown;
  position?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createSupabaseVideosClient(
  options: SupabaseVideosClientOptions,
): VideosClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /** Same headers on every call: the project key plus the caller's token. */
  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** GET a list of rows. Any failure is an empty list, never a crash. */
  async function readRows(path: string): Promise<unknown[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(found.url + path, {
      method: 'GET',
      headers: restHeaders({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body : [];
  }

  /** The caller's own id, checked before it goes into a URL. */
  function ownId(): string {
    if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
    return options.userId;
  }

  async function listByTeacher(teacherId: string): Promise<TeacherVideo[]> {
    // An id that is not a uuid is "no videos", not a crash: the page then
    // renders its empty state. It also never reaches the URL.
    if (!UUID_RE.test(teacherId)) return [];

    const rows = await readRows(
      `${TABLE}?select=${COLUMNS}&teacher_id=eq.${encodeURIComponent(teacherId)}` +
        '&order=position.asc',
    );
    return mapVideos(rows);
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    listMine() {
      return listByTeacher(options.userId);
    },

    listForTeacher(teacherId: string) {
      return listByTeacher(teacherId);
    },

    async add(input: AddVideoInput) {
      // The id is checked here as well as in SQL. Belt and braces: a bad value
      // must never be stored, because it ends up in an `<img src>` later.
      if (!isValidYouTubeId(input.youtubeId)) throw new Error('not a YouTube video id');
      const teacherId = ownId();
      const { url } = required();

      const res = await doFetch(url + TABLE, {
        method: 'POST',
        headers: restHeaders({ prefer: 'return=minimal' }),
        body: JSON.stringify({
          // The owner comes from the session, never from a body. The insert
          // policy would refuse a mismatch anyway.
          teacher_id: teacherId,
          youtube_id: input.youtubeId,
          title: input.title,
          thumb_url: input.thumbUrl,
          position: input.position,
        }),
        cache: 'no-store',
      });
      // The status only: the body quotes the Postgres policy by name.
      if (!res.ok) throw new Error('Supabase add video failed with status ' + res.status);
    },

    async remove(id: string) {
      if (!UUID_RE.test(id)) throw new Error('video id must be a uuid');
      const teacherId = ownId();
      const { url } = required();

      // `teacher_id` is in the filter as well as the policy. Belt and braces:
      // a delete can then never reach past the caller's own rows.
      const res = await doFetch(
        `${url}${TABLE}?id=eq.${encodeURIComponent(id)}` +
          `&teacher_id=eq.${encodeURIComponent(teacherId)}`,
        {
          method: 'DELETE',
          headers: restHeaders({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('Supabase remove video failed with status ' + res.status);
    },

    async readVisible() {
      // No filter needed: `teachers_select_own` leaves exactly the caller's
      // own row visible, so `limit=1` is their row or nothing.
      const rows = await readRows(`${TEACHERS}?select=videos_visible&limit=1`);
      const first = rows[0] as { videos_visible?: unknown } | undefined;
      // True when there is nothing to read, which matches the column default
      // in 0005: a new teacher starts with their Videos on Show.
      return first?.videos_visible !== false;
    },

    async setVisible(visible: boolean) {
      const teacherId = ownId();
      const { url } = required();

      const res = await doFetch(
        `${url}${TEACHERS}?user_id=eq.${encodeURIComponent(teacherId)}`,
        {
          method: 'PATCH',
          headers: restHeaders({ prefer: 'return=minimal' }),
          // Only this one column. `status` and `revenue_share_pct` are
          // admin-only and the 0005 trigger would raise for them anyway.
          body: JSON.stringify({ videos_visible: visible }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('Supabase set visible failed with status ' + res.status);
    },
  };
}

/**
 * Rows of `teacher_videos` to `TeacherVideo`. One place, so `listMine` and
 * `listForTeacher` cannot drift apart.
 *
 * A row with no id, no owner or an id that is not a YouTube id is DROPPED, not
 * patched up: better a short list than a value that lands in an `<img src>`.
 */
function mapVideos(rows: unknown[]): TeacherVideo[] {
  const out: TeacherVideo[] = [];
  for (const raw of rows as VideoRow[]) {
    const id = text(raw.id);
    const teacherId = text(raw.teacher_id);
    const youtubeId = text(raw.youtube_id);
    if (id === null || teacherId === null || !isValidYouTubeId(youtubeId)) continue;
    out.push({
      id,
      teacherId,
      youtubeId,
      title: text(raw.title),
      thumbUrl: text(raw.thumb_url),
      position: typeof raw.position === 'number' ? raw.position : 0,
    });
  }
  return out;
}
