/**
 * The server reads this slice needs (issue 10-papers-upload-browse): the
 * teacher's own Papers screen, and a student browsing `/t/<id>/papers`.
 *
 * Server only. Every read runs HERE, on the server, with the caller's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides the
 * rows and the browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 on a free page.
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabasePapersClient } from './supabase-papers-client';
import type { Paper } from './types';

export function papersClient(session: AuthSession | null) {
  return createSupabasePapersClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/** The caller's own papers, drafts included, for the teacher's screen. */
export async function readMyPapers(session: AuthSession | null): Promise<Paper[]> {
  if (!session) return [];
  return papersClient(session)
    .listMine()
    .catch(() => []);
}

/**
 * One teacher's LIVE papers, for a student. The status filter is in the query
 * as well as in the `papers_select_live` policy, so a teacher opening their own
 * portfolio sees what a student sees and not their own drafts.
 */
export async function readLivePapers(
  session: AuthSession | null,
  teacherId: string,
): Promise<Paper[]> {
  if (!session) return [];
  return papersClient(session)
    .listLiveForTeacher(teacherId)
    .catch(() => []);
}
