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
 * The read fails SOFT: a Supabase hiccup gives a tab that still renders, never
 * a 500. What it does NOT do any more is lie
 * (issue 54c-read-errors-saved-practice-media). `readSavedQuestionsResult`
 * tells an empty read from a failed one, so the tab shows the shared error
 * state instead of "Nothing saved yet. Wrong answers come here on their own."
 * while the rows are sitting there unread.
 *
 * The query is the same query it has always sent: the same `list` call on the
 * same client, so the same columns and the same order. The only new thing is a
 * probe handed to the client in place of `fetch`, which remembers a non-ok
 * status on the way past. The client itself is untouched and still turns a 400
 * into `[]` inside itself; the probe is what lets the reader know it happened.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 */
import type { AuthSession } from '@/lib/auth/types';
import { readOk, readWithProbe, type ReadResult } from '@/lib/read-result';
import { createSupabaseSavedClient } from './supabase-saved-client';
import type { SavedItem } from './types';

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface SavedReadOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function savedClient(
  session: AuthSession | null,
  options: SavedReadOptions = {},
  fetchImpl?: typeof fetch,
) {
  return createSupabaseSavedClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
    ...(options.env ? { env: options.env } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * The caller's own saved questions, newest first, and whether the read worked.
 *
 * Both tags, one list (F-E8).
 */
export async function readSavedQuestionsResult(
  session: AuthSession | null,
  options: SavedReadOptions = {},
): Promise<ReadResult<SavedItem[]>> {
  // Signed out is not broken: there is nothing to read, so it is an OK empty
  // read and the tab keeps its empty state.
  if (!session) return readOk<SavedItem[]>([]);

  return readWithProbe(
    (fetchImpl) =>
      savedClient(session, options, fetchImpl)
        .list()
        .catch(() => [] as SavedItem[]),
    options.fetchImpl,
  );
}

/** The caller's own saved questions, for callers that have no error state yet. */
export async function readSavedQuestions(
  session: AuthSession | null,
  options: SavedReadOptions = {},
): Promise<SavedItem[]> {
  const read = await readSavedQuestionsResult(session, options);
  return read.ok ? read.data : [];
}
