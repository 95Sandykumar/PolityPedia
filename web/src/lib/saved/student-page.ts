/**
 * The server read the Saved tab needs (issue 14-saved-list).
 *
 * Server only. The read runs HERE, with the student's own access token out of
 * the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key. Another student's saved questions cannot reach
 * this page at all (`saved_questions_select_own`).
 *
 * ONE REQUEST FOR THE WHOLE TAB. The question comes back embedded with each
 * saved row, so the list draws without a round trip per row, and the two chips
 * filter what is already in the page (DESIGN.md section 10).
 *
 * The read fails SOFT: a Supabase hiccup gives an empty list and a tab that
 * still renders, never a 500.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseSavedClient } from './supabase-saved-client';
import type { SavedItem } from './types';

export function savedClient(session: AuthSession | null) {
  return createSupabaseSavedClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/** The caller's own saved questions, newest first. Both tags, one list (F-E8). */
export async function readSavedQuestions(
  session: AuthSession | null,
): Promise<SavedItem[]> {
  if (!session) return [];
  return savedClient(session)
    .list()
    .catch(() => []);
}
