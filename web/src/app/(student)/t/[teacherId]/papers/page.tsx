/**
 * Student browse: `/t/<teacherId>/papers` (issue 10-papers-upload-browse).
 *
 * V8: past papers are FREE, so there is no plan check and no paywall on this
 * page. What a student gets is the teacher's LIVE papers, grouped
 * Exam > Year > Month, each with a download button (PRD F-D1 and F-D4).
 *
 * Every read runs HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides: a draft never
 * reaches this page, and neither does a paper of a teacher who is not approved
 * yet.
 *
 * Each row also carries a Practice link into the question player
 * (issue 13-question-player), which answers the paper's live questions one by
 * one with the result on the same screen.
 */
import { PapersList } from '@/components/papers-list';
import { BackLink, PageHeader } from '@/components/student-ui';
import { readStudentContext } from '@/lib/follows/student-page';
import { readPaperProgress } from '@/lib/papers/progress';
import { readLivePapersResult } from '@/lib/papers/student-page';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';
import { plain } from '@/lib/i18n';

export default async function TeacherPapersPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();

  // `ok` and `data` apart, so a read that FAILED can never reach the list as
  // an empty one (issue 54a-read-error-core).
  const [exams, read] = configured
    ? await Promise.all([readExamCatalogue(session), readLivePapersResult(session, teacherId)])
    : [[], { ok: true, data: [] } as const];
  const papers = read.ok ? read.data : [];
  // One question query and one attempt query for the whole list (B8).
  const progress = configured
    ? await readPaperProgress(
        session,
        papers.map((paper) => paper.id),
      )
    : new Map();

  return (
    <section className="flex flex-col gap-4">
      <BackLink href={`/t/${teacherId}`} mode={mode} />
      <PageHeader titleKey="tile.papers" mode={mode} />

      {configured ? (
        <PapersList
          papers={papers}
          failed={!read.ok}
          exams={exams}
          mode={mode}
          playTeacherId={teacherId}
          progress={progress}
        />
      ) : (
        <p role="status" className="text-muted-foreground">
          {plain('papers.notConfigured', mode)}
        </p>
      )}
    </section>
  );
}
