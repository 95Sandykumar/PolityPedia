/**
 * Mock test in PRACTICE mode: `/t/<teacherId>/mocks/<testId>/play`
 * (issue 17-practice-mode).
 *
 * THIS IS THE START ROUTE. Opening it creates (or resumes) the `attempts` row
 * for this test, in practice mode, with the topic the student chose on the
 * mock list. Its own URL, so Back works and a test can be shared (DESIGN.md
 * section 7); `mockPlayerPath()` on the list builds the link, and the mode and
 * the topic ride in the QUERY, so this page reads a choice the student already
 * made rather than guessing one.
 *
 * Every read runs HERE, on the server, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides. A LOCKED test gets
 * no questions (`0016_set_access.sql`) and no sitting at all
 * (`attempts_mock_needs_access` in `0017`), so tapping Attempt on a locked row
 * lands on a page that says it is not ready, never on a player with nothing
 * in it.
 *
 * The player component is the one issue 13 wrote, unchanged: practice means
 * the result is on the SAME screen after every tap (D3) and there is no timer.
 * What this slice hands it is the exam's MARKING (F-E6), so the score at the
 * end is marks and not a count of right answers.
 *
 * `mode=exam` is issue 18-exam-mode. The link already carries it, so this page
 * reads it and says "coming soon" rather than quietly running a timed paper
 * with no timer.
 */
import { PlaceholderPage } from '@/components/placeholder-page';
import { PracticePlayer } from '@/components/practice-player';
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

  // Timed mode is issue 18. Say so instead of running practice under its name.
  if (attemptMode === 'exam') {
    return <PlaceholderPage titleKey="mockList.exam" mode={mode} />;
  }

  const practice = configured
    ? await readMockPracticeData(session, testId, {
        mode: attemptMode,
        topicId,
        langMode: mode,
      })
    : null;

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels('mockList.practice', mode).map((line, index) => (
          <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
            {line}
          </span>
        ))}
      </h1>

      {/* No keys, a locked test, or no sitting to write into: say so rather
          than take answers the player cannot store. */}
      {practice?.attempt ? (
        <PracticePlayer
          questions={practice.questions}
          attemptId={practice.attempt.id}
          mode={mode}
          examName={practice.heading}
          marking={practice.marking}
          startedAnswers={practice.answers}
        />
      ) : (
        <p role="status" className="text-muted-foreground">
          {plain('player.notConfigured', mode)}
        </p>
      )}
    </section>
  );
}
