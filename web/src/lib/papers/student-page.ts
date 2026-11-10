/**
 * The student's past-papers read, with a FAILED read told apart from an empty
 * one (issue 54a-read-error-core).
 *
 * Server only. The read runs HERE, with the student's own access token out of
 * the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key.
 *
 * Why a new file and not `teacher-page.ts`: that file is the TEACHER's screen
 * as well, and the teacher screens get this treatment in ticket 54. This one
 * is the student's browse page only.
 *
 * The query is the same query `readLivePapers` has always sent: the same
 * `listLiveForTeacher` call on the same client, so the same columns and the
 * same `status=eq.live` filter. The only new thing is a probe handed to the
 * client in place of `fetch`, which remembers a non-ok status on the way past.
 * The client itself is untouched and still turns a 400 into `[]` inside
 * itself; the probe is what lets the reader know it happened.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 */
import type { AuthSession } from '@/lib/auth/types';
import { readOk, readWithProbe, type ReadResult } from '@/lib/read-result';
import { createSupabasePapersClient } from './supabase-papers-client';
import type { Paper } from './types';

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface LivePapersOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * One teacher's LIVE papers for a student, and whether the read worked.
 *
 * The status filter is in the query as well as in the `papers_select_live`
 * policy, so a teacher opening their own portfolio sees what a student sees
 * and not their own drafts.
 */
export async function readLivePapersResult(
  session: AuthSession | null,
  teacherId: string,
  options: LivePapersOptions = {},
): Promise<ReadResult<Paper[]>> {
  // Signed out is not broken: there is nothing to read, so it is an OK empty
  // read and the page keeps its empty state.
  if (!session) return readOk<Paper[]>([]);

  return readWithProbe(async (fetchImpl) => {
    const client = createSupabasePapersClient({
      accessToken: session.accessToken,
      userId: session.userId,
      ...(options.env ? { env: options.env } : {}),
      fetchImpl,
    });
    return client.listLiveForTeacher(teacherId).catch(() => [] as Paper[]);
  }, options.fetchImpl);
}
