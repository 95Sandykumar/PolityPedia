/**
 * Teacher review: check every question of one paper, then publish
 * (issue 11-ingest-job-review-publish).
 *
 * PRD F-D3: each question next to its PDF page. Edit, then publish. Nothing
 * goes live before publish.
 *
 * All three reads run HERE, on the server, with the teacher's own access token
 * out of the httpOnly session cookie, so Postgres RLS decides and the browser
 * never holds a key. A paper that is not the caller's own comes back null and
 * the screen says "Paper not found", which is also what a stranger gets.
 *
 * The screen keeps itself up to date from the job row over Realtime, and asks
 * this page to read again once the split has finished. That is why the reads
 * live here and not in the client component: there is ONE place that knows how
 * to read a question.
 */
import { TeacherReview } from '@/components/teacher-review';
import { readStudentContext } from '@/lib/follows/student-page';
import { papersClient } from '@/lib/papers/teacher-page';
import { readReviewData } from '@/lib/questions/teacher-page';

export default async function TeacherPaperReviewPage({
  params,
}: {
  params: Promise<{ paperId: string }>;
}) {
  const { paperId } = await params;
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: render the "not configured" state rather than firing
  // reads that cannot work (web/CLAUDE.md).
  if (!configured) {
    return <TeacherReview paper={null} questions={[]} job={null} mode={mode} configured={false} />;
  }

  // Fails soft: a Supabase hiccup shows "Paper not found", never a 500.
  const paper = await papersClient(session)
    .readOne(paperId)
    .catch(() => null);

  const { questions, job } = paper
    ? await readReviewData(session, paper.id)
    : { questions: [], job: null };

  return (
    <TeacherReview paper={paper} questions={questions} job={job} mode={mode} />
  );
}
