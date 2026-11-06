/**
 * Student practice: `/t/<teacherId>/papers/<paperId>/play`
 * (issue 13-question-player).
 *
 * Its own URL, so Back works and a paper can be shared (DESIGN.md section 7).
 *
 * V8: past papers are FREE, so there is no plan check and no paywall here.
 * What a student gets is the paper's LIVE questions, one at a time, with the
 * result on the same screen (D3).
 *
 * Every read runs HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides: a DRAFT question
 * cannot reach this page, and neither can a paper of a teacher who is not
 * approved yet (V9, Risk 1).
 *
 * The whole paper is read in ONE request and handed down as a prop, so the
 * player never waits between questions (DESIGN.md section 10).
 */
import { PracticePlayer } from '@/components/practice-player';
import { BackLink, EmptyState, PageHeader } from '@/components/student-ui';
import { ListChecks } from 'lucide-react';
import { readPracticeData, examNameOf } from '@/lib/attempts/student-page';
import { readStudentContext } from '@/lib/follows/student-page';
import { readLivePapers } from '@/lib/papers/teacher-page';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';
import { plain } from '@/lib/i18n';

export default async function PaperPlayPage({
  params,
}: {
  params: Promise<{ teacherId: string; paperId: string }>;
}) {
  const { teacherId, paperId } = await params;
  const { session, configured, mode } = await readStudentContext();

  const [practice, exams, papers] = configured
    ? await Promise.all([
        readPracticeData(session, paperId),
        readExamCatalogue(session),
        readLivePapers(session, teacherId),
      ])
    : [{ questions: [], attempt: null, answers: [] }, [], []];

  const examName = examNameOf(
    papers.find((one) => one.id === paperId),
    exams,
    mode,
  );

  return (
    <section className="flex flex-col gap-3">
      <BackLink href={`/t/${teacherId}/papers`} mode={mode} labelKey="sui.backToPapers" />
      <PageHeader titleKey="player.title" mode={mode} />

      {/* No keys, or no sitting to write into: say so rather than take answers
          the player cannot store. */}
      {configured && practice.attempt ? (
        <PracticePlayer
          questions={practice.questions}
          attemptId={practice.attempt.id}
          mode={mode}
          examName={examName}
          startedAnswers={practice.answers}
        />
      ) : (
        <EmptyState Icon={ListChecks} text={plain('player.notConfigured', mode)} />
      )}
    </section>
  );
}
