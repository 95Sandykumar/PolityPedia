/**
 * The server read behind the batch score table (issue 20-batch-reports).
 *
 * Two facts, and they are both about a page that must still render:
 *
 *  * nobody signed in gives an EMPTY report and asks Supabase nothing,
 *  * with no env set the read is still empty and still does not throw, which
 *    is what lets `npm run build` and `npm test` run with no environment
 *    variables at all (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { readBatchReport } from '../teacher-page';
import type { AuthSession } from '@/lib/auth/types';

const BATCH = '33333333-3333-4333-8333-333333333333';

const SESSION: AuthSession = {
  accessToken: 'caller.token',
  refreshToken: 'refresh',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'teacher',
  teacherStatus: 'approved',
};

describe('readBatchReport', () => {
  it('is empty with no session, and never throws', async () => {
    await expect(readBatchReport(null, BATCH)).resolves.toEqual({ tests: [], scores: [] });
  });

  it('is empty with no Supabase env, so the batch page still renders', async () => {
    // The suite runs with no NEXT_PUBLIC_SUPABASE_* set, so this is the real
    // build-time path and not a stub of one.
    await expect(readBatchReport(SESSION, BATCH)).resolves.toEqual({ tests: [], scores: [] });
  });
});
