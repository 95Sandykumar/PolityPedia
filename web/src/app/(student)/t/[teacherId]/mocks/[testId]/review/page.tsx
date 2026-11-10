/**
 * Mock test review: `/t/<teacherId>/mocks/<testId>/review` (ticket 57b).
 *
 * THIS IS NOT A START ROUTE, and that is the whole point of it. `play` creates
 * or resumes the `attempts` row; this page creates nothing. Persona-1 gap 5
 * was that "Review" on a finished test opened the PLAYER, so every look at an
 * old paper left a fresh blank sitting behind, and in exam mode it could start
 * a new timed one. The reader of 57a has no write method and this page holds
 * no client, no queue and no `fetch`, so there is nothing here to get wrong
 * later: a page view is a read, by construction.
 *
 * Its own URL, so Back works and a finished test can be re-opened from a list
 * (DESIGN.md section 7). The read runs HERE, on the server, with the student's
 * own access token out of the httpOnly session cookie, so Postgres decides:
 * `attempts_select_own` (0013) hides another student's sitting, and
 * `question_keys()` / `question_explanations()` (0030, 0037) refuse the key
 * and the prose while an exam of the same test is still open.
 *
 * ONE SHAPE FOR EVERY "NOTHING TO SHOW". No submitted sitting, every sitting
 * still open, a sitting that belongs to somebody else, and no session at all
 * ALL draw the same line. The reader already collapses the first three into
 * one null on purpose, and a page that said something different for one of
 * them would hand back exactly the difference 57a hid: whether a sitting
 * exists, and whose it is.
 *
 * RETAKE GOES TO `play`, in the mode of the sitting being reviewed, because
 * the start route is the only place a sitting is ever created. The list link
 * and the Retake wiring for the rest of the app are ticket 57c.
 */
import { AttemptReviewPanel } from '@/components/attempt-review';
import { BackLink, EmptyState, PageHeader } from '@/components/student-ui';
import { History } from 'lucide-react';
import { createSupabaseReviewSource, readAttemptReview } from '@/lib/attempts/review';
import { readStudentContext } from '@/lib/follows/student-page';
import { plain } from '@/lib/i18n';

export default async function MockReviewPage({
  params,
}: {
  params: Promise<{ teacherId: string; testId: string }>;
}) {
  const { teacherId, testId } = await params;
  const { session, mode } = await readStudentContext();

  // No session is no token, so there is nothing to read with and nothing to
  // read: the same null every other "nothing to review" produces.
  const review = session
    ? await readAttemptReview(
        createSupabaseReviewSource({ accessToken: session.accessToken }),
        { testId },
      ).catch(() => null)
    : null;

  return (
    <section className="flex flex-col gap-3">
      <BackLink href={`/t/${teacherId}/mocks`} mode={mode} labelKey="sui.backToMocks" />
      <PageHeader titleKey="recap.title" mode={mode} />

      {review ? (
        <AttemptReviewPanel
          review={review}
          mode={mode}
          // The start route of the SAME test, in the mode they just sat, so
          // Retake gives them the paper they asked to do again and not the
          // other kind of it.
          retakeHref={`/t/${teacherId}/mocks/${testId}/play?mode=${review.mode}`}
        />
      ) : (
        <EmptyState Icon={History} text={plain('recap.none', mode)} />
      )}
    </section>
  );
}
