/**
 * The server read behind the batch score table (issue 20-batch-reports).
 *
 * Server only. The read runs HERE, with the caller's own access token out of
 * the httpOnly session cookie, so the owner-rights views in
 * `0020_batch_reports.sql` decide the rows and the browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * The read fails SOFT. A Supabase hiccup gives an EMPTY report and a batch
 * page that still shows its join code and its roll, never a 500 on a teacher's
 * dashboard.
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseReportsClient } from './supabase-reports-client';
import { EMPTY_BATCH_REPORT, type BatchReport } from './types';

export function reportsClient(session: AuthSession | null) {
  return createSupabaseReportsClient({ accessToken: session?.accessToken ?? '' });
}

/**
 * One batch's score report, or an empty one.
 *
 * Empty is also what a teacher gets for somebody else's batch, because the
 * views hid every row. The screen shows the same empty state either way, so it
 * never tells a teacher that somebody else's batch is out there.
 */
export async function readBatchReport(
  session: AuthSession | null,
  batchId: string,
): Promise<BatchReport> {
  if (!session) return { ...EMPTY_BATCH_REPORT };
  return reportsClient(session)
    .readBatchReport(batchId)
    .catch(() => ({ ...EMPTY_BATCH_REPORT }));
}
