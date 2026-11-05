/**
 * GET /api/tests/<id>/load?mode=exam -> the paper WITHOUT the answer key
 * (issue 18-exam-mode).
 *
 * Thin adapter. Every rule lives in `@/lib/exam/exam-route`, which the tests
 * drive directly, including the key test of this slice: the payload carries no
 * `correct_idx` and no `teacher_explanation` (F-E5).
 *
 * THIS IS ALSO THE START OF THE CLOCK. The read behind it creates the
 * `attempts` row with `deadline_at = now + duration`, or resumes the open one,
 * so a refresh does not buy the student another hour.
 *
 * GET, and it does write (the sitting). That is deliberate: the exam player
 * re-reads this route after submit to get the review, and a student who shares
 * or re-opens the link must land in the SAME sitting. Resuming is what makes
 * the write idempotent, so a prefetch costs one row at most, not one per tap.
 *
 * `no-store`, because the reply is a student's own open sitting and its clock.
 * A cached copy would hand somebody else's paper, or a dead deadline, to the
 * next reader.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleExamLoad } from '@/lib/exam/exam-route';
import { readExamLoad } from '@/lib/exam/student-page';
import { readStudentContext } from '@/lib/follows/student-page';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, { session, mode }] = await Promise.all([params, readStudentContext()]);
  const query = Object.fromEntries(new URL(request.url).searchParams);

  const reply = await handleExamLoad({
    testId: id,
    query,
    session,
    langMode: mode,
    load: (testId, options) => readExamLoad(session, testId, options),
  });

  return NextResponse.json(reply.body, {
    status: reply.status,
    headers: { 'cache-control': 'no-store' },
  });
}
