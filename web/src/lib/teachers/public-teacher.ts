/**
 * The one teacher read an ANONYMOUS caller is allowed (issue 63-public-landing).
 *
 * A shared `/t/<teacherId>` link arrives with no session cookie, so there is
 * no user access token to send. 0005 already granted `select on
 * public.teachers_public to anon`, so this read works with the project anon
 * key as the bearer and this slice adds NO migration.
 *
 * Design constraint C, and how each half is kept:
 *  - "show only public fields": the request goes to the VIEW, which has no
 *    `real_name` column at all, and asks for named columns, never `select=*`.
 *  - "never an alias teacher's real name": the view itself swaps in the alias
 *    (SQL, not this file).
 *  - "no signed-in data cached or shown to anonymous callers": no user token
 *    is ever sent from here, and the underlying fetch is `cache: 'no-store'`,
 *    so one visitor's answer is never handed to the next.
 *
 * Fails SOFT. A missing env, a bad id, a 401 or a dead network all give
 * `null`, and the page then shows the landing pitch instead of a 500. A
 * shared link is the first thing a new student ever opens: it must not break.
 */
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import type { PublicTeacher } from '@/lib/teachers/types';

export interface PublicTeacherDeps {
  /** Injected in tests. Defaults to `process.env`, read lazily. */
  env?: Record<string, string | undefined>;
  /** Injected in tests, so no test makes a real network call. */
  fetchImpl?: typeof fetch;
}

/**
 * One approved teacher as a logged-out visitor may see them, or null.
 *
 * The empty access token is the whole point: it tells the client there is no
 * signed-in caller, so the request runs as the Postgres `anon` role and the
 * grants decide what comes back.
 */
export async function readPublicTeacher(
  teacherId: string,
  deps: PublicTeacherDeps = {},
): Promise<PublicTeacher | null> {
  const client = createSupabaseTeachersClient({
    accessToken: '',
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  if (!client.isConfigured()) return null;

  return client.readPublic(teacherId).catch(() => null);
}
