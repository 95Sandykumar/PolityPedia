/**
 * GET /api/attempts/<attemptId>/result -> the result of ONE submitted sitting
 * (issue 56-result-page).
 *
 * Thin adapter. Every rule lives in `readAttemptResult()` (ticket 56a), which
 * `web/test/attempt-result.test.ts` drives against real Postgres through
 * PGlite: the score is the stored one (0031), the answer key comes only from
 * `question_keys()` and only after the close (0030), and another student's
 * sitting is hidden by `attempts_select_own` (0013).
 *
 * ONE SHAPE FOR EVERY "NOTHING TO SHOW". An open sitting, an id that does not
 * exist and another student's sitting all answer 200 with `{ result: null }`.
 * A 404 for one and a 403 for another would be the leak: the difference
 * between "no such sitting" and "not yours" is exactly what a student probing
 * ids wants to learn.
 *
 * `no-store`, because the reply is one student's own mark.
 *
 * Security: nothing here is logged. The cookie holds tokens, and the reader
 * never puts a Postgres message in its reply.
 */
import { NextResponse } from 'next/server';
import { createSupabaseResultSource, readAttemptResult } from '@/lib/attempts/result';
import { readStudentContext } from '@/lib/follows/student-page';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const [{ attemptId }, { session }] = await Promise.all([params, readStudentContext()]);

  // No session is no sitting. 200 and null, for the same reason as above.
  const result = session
    ? await readAttemptResult(
        createSupabaseResultSource({ accessToken: session.accessToken }),
        attemptId,
      ).catch(() => null)
    : null;

  return NextResponse.json({ result }, { headers: { 'cache-control': 'no-store' } });
}
