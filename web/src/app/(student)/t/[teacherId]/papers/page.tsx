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
 * The question player over these PDFs is issue 12.
 */
import { PapersList } from '@/components/papers-list';
import { readStudentContext } from '@/lib/follows/student-page';
import { readLivePapers } from '@/lib/papers/teacher-page';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';
import { labels } from '@/lib/i18n';

export default async function TeacherPapersPage({
  params,
}: {
  params: Promise<{ teacherId: string }>;
}) {
  const { teacherId } = await params;
  const { session, configured, mode } = await readStudentContext();

  const [exams, papers] = configured
    ? await Promise.all([readExamCatalogue(session), readLivePapers(session, teacherId)])
    : [[], []];

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels('tile.papers', mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>

      {configured ? (
        <PapersList papers={papers} exams={exams} mode={mode} />
      ) : (
        <p role="status" className="text-muted-foreground">
          {labels('papers.notConfigured', mode).join(' / ')}
        </p>
      )}
    </section>
  );
}
