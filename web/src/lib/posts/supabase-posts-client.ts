/**
 * Server-side TeacherPostsClient over the Supabase REST API
 * (issue 09-teacher-notifications).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN CALLER'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `teacher_posts_select_approved`, `teacher_posts_select_own`,
 * `teacher_posts_insert_own` and `teacher_posts_delete_own` policies in
 * `0009_teacher_posts.sql`.
 *
 * `userId` is passed in from the session cookie, never from a request body,
 * because `teacher_posts.teacher_id` is the row owner. The insert policy would
 * refuse a mismatch anyway; sending the caller's own id keeps the round trip
 * honest and lets the DELETE filter on it too.
 *
 * Every read FAILS SOFT: a Supabase hiccup is an empty list, so the Home tab
 * still renders. Writes throw, because a teacher must be told the notice did
 * not save.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  DEFAULT_PRIORITY,
  isPriority,
  normalizeHeading,
  normalizeLink,
  type NewTeacherPost,
  type TeacherPost,
  type TeacherPostsClient,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/teacher_posts';

/** Columns the screens need. Never `select=*`, so a new column cannot leak. */
const COLUMNS = 'id,teacher_id,priority,heading,link,created_at';

/** V17: loudest first, then newest. The index in 0009 matches this exactly. */
const ORDER = 'order=priority.desc,created_at.desc';

export interface SupabaseTeacherPostsClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface PostRow {
  id?: unknown;
  teacher_id?: unknown;
  priority?: unknown;
  heading?: unknown;
  link?: unknown;
  created_at?: unknown;
}

export function createSupabaseTeacherPostsClient(
  options: SupabaseTeacherPostsClientOptions,
): TeacherPostsClient {
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
  async function readRows(query: string): Promise<unknown[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(found.url + TABLE + query, {
      method: 'GET',
      headers: restHeaders({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body : [];
  }

  /** The caller's own id, checked before it goes anywhere near a URL. */
  function ownId(): string {
    if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
    return options.userId;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listForTeacher(teacherId: string) {
      // An id that is not a uuid is "no such teacher", not a crash, and it
      // never reaches the URL where it could steer the request.
      if (!UUID_RE.test(teacherId)) return [];

      const rows = await readRows(
        `?select=${COLUMNS}&teacher_id=eq.${encodeURIComponent(teacherId)}&${ORDER}`,
      );
      return mapPosts(rows);
    },

    async listForTeachers(teacherIds: readonly string[], limit: number) {
      const ids = teacherIds.filter((id) => UUID_RE.test(id));
      if (ids.length === 0) return [];

      const inList = ids.map((id) => encodeURIComponent(id)).join(',');
      const capped = Math.max(1, Math.min(100, Math.floor(limit)));
      const rows = await readRows(
        `?select=${COLUMNS}&teacher_id=in.(${inList})&${ORDER}&limit=${capped}`,
      );
      return mapPosts(rows);
    },

    async listMine() {
      const rows = await readRows(
        `?select=${COLUMNS}&teacher_id=eq.${encodeURIComponent(ownId())}&${ORDER}`,
      );
      return mapPosts(rows);
    },

    async create(input: NewTeacherPost) {
      // Checked HERE as well as in the route, because this is the last place
      // before the wire and Postgres is the one after it.
      const heading = normalizeHeading(input.heading);
      if (heading === null) throw new Error('heading is missing or too long');
      if (!isPriority(input.priority)) throw new Error('priority is not one of ours');
      const link = input.link === null ? null : normalizeLink(input.link);
      if (input.link !== null && link === null) throw new Error('link must be http or https');

      const teacherId = ownId();
      const { url } = required();

      const res = await doFetch(url + TABLE + `?select=${COLUMNS}`, {
        method: 'POST',
        // The stored row comes back, so the page shows the real id and date
        // and does not have to guess them.
        headers: restHeaders({ prefer: 'return=representation' }),
        body: JSON.stringify({ teacher_id: teacherId, heading, priority: input.priority, link }),
        cache: 'no-store',
      });
      // The status only: the body quotes the Postgres policy by name.
      if (!res.ok) throw new Error('Supabase create post failed with status ' + res.status);

      const body = (await res.json()) as unknown;
      const saved = mapPosts(Array.isArray(body) ? body : [body])[0];
      if (!saved) throw new Error('Supabase create post returned no row');
      return saved;
    },

    async remove(postId: string) {
      if (!UUID_RE.test(postId)) throw new Error('post id must be a uuid');
      const teacherId = ownId();
      const { url } = required();

      // `teacher_id` is in the filter as well as the policy. Belt and braces:
      // a delete can then never reach past the caller's own posts.
      const res = await doFetch(
        `${url}${TABLE}?id=eq.${encodeURIComponent(postId)}` +
          `&teacher_id=eq.${encodeURIComponent(teacherId)}`,
        {
          method: 'DELETE',
          headers: restHeaders({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('Supabase delete post failed with status ' + res.status);
    },
  };
}

/**
 * Rows of `teacher_posts` to `TeacherPost`. One place, so every read maps the
 * same columns the same way.
 *
 * A row with no id, no author or no heading is DROPPED rather than shown with
 * a fallback: a blank notice tells a student nothing and a fallback is how a
 * placeholder ends up on a real screen.
 *
 * The link goes back through `normalizeLink`, so even a row written by some
 * other road cannot put a `javascript:` href into the page.
 */
function mapPosts(rows: unknown[]): TeacherPost[] {
  const out: TeacherPost[] = [];
  for (const raw of rows as PostRow[]) {
    const id = text(raw?.id);
    const teacherId = text(raw?.teacher_id);
    const heading = normalizeHeading(raw?.heading);
    if (id === null || teacherId === null || heading === null) continue;

    out.push({
      id,
      teacherId,
      // A priority we do not know reads as normal, so the notice still shows
      // instead of vanishing.
      priority: isPriority(raw?.priority) ? raw.priority : DEFAULT_PRIORITY,
      heading,
      link: normalizeLink(raw?.link),
      createdAt: text(raw?.created_at) ?? '',
    });
  }
  return out;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
