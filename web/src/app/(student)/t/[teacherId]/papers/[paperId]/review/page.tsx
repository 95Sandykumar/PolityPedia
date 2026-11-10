/**
 * Past paper review: `/t/<teacherId>/papers/<paperId>/review` (ticket 57b).
 *
 * The same page as the mock review, over a paper instead of a test, and for
 * the same reason: `play` is the start route and creates or resumes the
 * `attempts` row, so "Review" must never point there. This page creates
 * nothing. The reader of 57a has no write method and this page holds no
 * client, no queue and no `fetch`.
 *
 * WHY IT IS A SECOND FILE AND NOT A QUERY. A sitting has a paper OR a test and
 * never both (`attempts_one_parent_check`, 0013), the two lists are different
 * screens, and the route segment is what makes Back and sharing work (DESIGN.md
 * section 7). The shared part is the reader and the panel, which is where the
 * logic lives; what differs here is one field of the target and where Retake
 * goes, and a page is the right place for both.
 *
 * Past papers are FREE (V8), so there is no plan check and no paywall. The read
 * still runs HERE, on the server, with the student's own token, so
 * `attempts_select_own` (0013) hides another student's sitting.
 *
 * ONE SHAPE FOR EVERY "NOTHING TO SHOW", as on the mock page: no submitted
 * sitting, a sitting still open, somebody else's sitting and no session at all
 * draw the same line, because the reader collapses them into one null and
 * telling them apart again is the leak.
 */
import { AttemptReviewPanel } from '@/components/attempt-review';
import { BackLink, EmptyState, PageHeader } from '@/components/student-ui';
import { History } from 'lucide-react';
import { createSupabaseReviewSource, readAttemptReview } from '@/lib/attempts/review';
import { readStudentContext } from '@/lib/follows/student-page';
import { plain } from '@/lib/i18n';

export default async function PaperReviewPage({
  params,
}: {
  params: Promise<{ teacherId: string; paperId: string }>;
}) {
  const { teacherId, paperId } = await params;
  const { session, mode } = await readStudentContext();

  const review = session
    ? await readAttemptReview(
        createSupabaseReviewSource({ accessToken: session.accessToken }),
        { paperId },
      ).catch(() => null)
    : null;

  return (
    <section className="flex flex-col gap-3">
      <BackLink href={`/t/${teacherId}/papers`} mode={mode} labelKey="sui.backToPapers" />
      <PageHeader titleKey="recap.title" mode={mode} />

      {review ? (
        <AttemptReviewPanel
          review={review}
          mode={mode}
          // The start route of the SAME paper. A past paper has one player and
          // no mode in its URL, so there is no mode to carry.
          retakeHref={`/t/${teacherId}/papers/${paperId}/play`}
        />
      ) : (
        <EmptyState Icon={History} text={plain('recap.none', mode)} />
      )}
    </section>
  );
}
