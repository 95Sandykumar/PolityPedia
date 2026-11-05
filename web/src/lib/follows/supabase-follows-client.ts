/**
 * Server-side FollowsClient over the Supabase REST API
 * (issue 06-portfolio-follow).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN STUDENT'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `follows_select_own`, `follows_insert_own` and `follows_delete_own` policies
 * in `0006_follows.sql`.
 *
 * `userId` is passed in from the session cookie, never from a request body,
 * because `follows.user_id` is the row owner. The insert policy would refuse a
 * mismatch anyway; sending the caller's own id keeps the round trip honest.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import type { FollowsClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/follows';

export interface SupabaseFollowsClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseFollowsClient(
  options: SupabaseFollowsClientOptions,
): FollowsClient {
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

  /**
   * Both ids go into a URL, so both are checked against the UUID shape first.
   * That is what stops a crafted id from steering the request at another path.
   */
  function checkedPair(teacherId: string): { userId: string; teacherId: string } {
    if (!UUID_RE.test(teacherId)) throw new Error('teacher id must be a uuid');
    if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
    return { userId: options.userId, teacherId };
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listFollowing() {
      const found = env();
      if (!found) return [];

      // Newest first, so Home shows the teacher the student just followed.
      const res = await doFetch(found.url + TABLE + '?select=teacher_id&order=created_at.desc', {
        method: 'GET',
        headers: restHeaders({ accept: 'application/json' }),
        cache: 'no-store',
      });
      // Any failure is an empty list, never a crash: Home still renders.
      if (!res.ok) return [];

      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];

      const out: string[] = [];
      for (const raw of body as { teacher_id?: unknown }[]) {
        if (typeof raw?.teacher_id === 'string' && raw.teacher_id.length > 0) {
          out.push(raw.teacher_id);
        }
      }
      return out;
    },

    async follow(teacherId: string) {
      const pair = checkedPair(teacherId);
      const { url } = required();

      const res = await doFetch(url + TABLE, {
        method: 'POST',
        // merge-duplicates makes a second tap a no-op instead of a 409, so a
        // slow network and an impatient student cannot produce an error.
        headers: restHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ user_id: pair.userId, teacher_id: pair.teacherId }),
        cache: 'no-store',
      });
      // The status only: the body quotes the Postgres policy by name.
      if (!res.ok) throw new Error('Supabase follow failed with status ' + res.status);
    },

    async unfollow(teacherId: string) {
      const pair = checkedPair(teacherId);
      const { url } = required();

      // `user_id` is in the filter as well as the policy. Belt and braces: a
      // delete can then never reach past the caller's own row.
      const res = await doFetch(
        `${url}${TABLE}?user_id=eq.${encodeURIComponent(pair.userId)}` +
          `&teacher_id=eq.${encodeURIComponent(pair.teacherId)}`,
        {
          method: 'DELETE',
          headers: restHeaders({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('Supabase unfollow failed with status ' + res.status);
    },
  };
}
