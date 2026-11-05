/**
 * Mock test player: `/t/<teacherId>/mocks/<testId>/play`
 *
 *   `?mode=practice` -> issue 17-practice-mode: no timer, result after every tap.
 *   `?mode=exam`     -> issue 18-exam-mode: a timer, and no answer until submit.
 *
 * THIS IS THE START ROUTE for both. Opening it creates (or resumes) the
 * `attempts` row for this test, in the mode and the topic the student chose on
 * the mock list. Its own URL, so Back works and a test can be shared
 * (DESIGN.md section 7); `mockPlayerPath()` on the list builds the link, and
 * the mode and the topic ride in the QUERY, so this page reads a choice the
 * student already made rather than guessing one.
 *
 * Every read runs HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides. A LOCKED test gets
 * no questions (`0016_set_access.sql`) and no sitting at all
 * (`attempts_mock_needs_access` in `0017`), so tapping Attempt on a locked row
 * lands on a page that says it is not ready, never on a player with nothing
 * in it.
 *
 * WHY EXAM MODE IS A DIFFERENT COMPONENT. In practice mode the page hands the
 * player whole `Question`s, because D3 shows the result after every tap. In
 * exam mode `readExamLoad` STRIPS `correct_idx` and `teacher_explanation`
 * before the payload leaves the server (F-E5), so the exam player is handed
 * questions that do not contain a right answer and cannot draw one. The timer
 * is a `deadline_at` in the row, and `0018_exam_mode.sql` refuses a write
 * after it, so the countdown on screen is a courtesy and not the gate.
 */
import { MockExamPlayer } from '@/components/mock-exam-player';
import { PracticePlayer } from '@/components/practice-player';
import { readExamLoad } from '@/lib/exam/student-page';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMockPracticeData } from '@/lib/practice/student-page';
import { readRequestedMode, readTopicFilter } from '@/lib/practice/types';
import { labels, plain } from '@/lib/i18n';

export default async function MockPlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ teacherId: string; testId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ testId }, query] = await Promise.all([params, searchParams]);
  const { session, configured, mode } = await readStudentContext();

  // Fails to PRACTICE: a broken query must never start a timed sitting.
  const attemptMode = readRequestedMode(query.mode);
  // "Full paper" is the absence of a filter, so it is not in the URL at all.
  const topicId = readTopicFilter(query.topic);

  const titleKey = attemptMode === 'exam' ? 'exam.title' : 'mockList.practice';

  const [practice, exam] = await Promise.all([
    configured && attemptMode === 'practice'
      ? readMockPracticeData(session, testId, { mode: attemptMode, topicId, langMode: mode })
      : Promise.resolve(null),
    configured && attemptMode === 'exam'
      ? readExamLoad(session, testId, { topicId, langMode: mode })
      : Promise.resolve(null),
  ]);

  const sitting = attemptMode === 'exam' ? exam?.attempt : practice?.attempt;

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels(titleKey, mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>

      {/* No keys, a locked test, or no sitting to write into: say so rather
          than take answers the player cannot store. */}
      {!sitting ? (
        <p role="status" className="text-muted-foreground">
          {plain(attemptMode === 'exam' ? 'exam.notConfigured' : 'player.notConfigured', mode)}
        </p>
      ) : attemptMode === 'exam' && exam?.attempt ? (
        <MockExamPlayer
          questions={exam.questions}
          attemptId={exam.attempt.id}
          testId={testId}
          topicId={topicId}
          deadlineAt={exam.attempt.deadlineAt}
          mode={mode}
          examName={exam.heading}
          marking={exam.marking}
          startedAnswers={exam.answers}
          revealed={exam.revealed}
          score={exam.attempt.score}
        />
      ) : practice?.attempt ? (
        <PracticePlayer
          questions={practice.questions}
          attemptId={practice.attempt.id}
          mode={mode}
          examName={practice.heading}
          marking={practice.marking}
          startedAnswers={practice.answers}
        />
      ) : null}
    </section>
  );
}
