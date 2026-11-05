/**
 * The one read the teacher explanation screen needs
 * (issue 24-revision-teacher-edit).
 *
 * Server only. It runs HERE, on the server, with the teacher's own access
 * token out of the httpOnly session cookie, so Postgres RLS decides the rows
 * and the browser never holds a key. The same shape as
 * `@/lib/posts/server-posts`.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * The read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 on the teacher's dashboard.
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseTeacherExplanationsClient } from './supabase-teacher-explanations-client';
import type { TeacherExplanation } from './teacher-edit';

/** Explanations of the caller's OWN questions, ready to correct. */
export async function readMyExplanations(
  session: AuthSession | null,
): Promise<TeacherExplanation[]> {
  return createSupabaseTeacherExplanationsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  })
    .listMine()
    .catch(() => []);
}
