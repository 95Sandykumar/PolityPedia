/**
 * The server read behind the mock-test player (issue 17-practice-mode).
 *
 * Server only. Every read runs HERE, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key. A locked test hands this page ZERO questions,
 * because of the restrictive policy in `0016_set_access.sql`, and the sitting
 * itself is refused by `attempts_mock_needs_access` in `0017`.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * ONE REQUEST FOR THE WHOLE PAPER (DESIGN.md section 10). Every question is
 * read here, once, and handed down as a prop, so the player never waits for a
 * network round trip between two questions. With a topic chosen, Postgres does
 * the filtering, so "one topic" is a SMALLER request and not the whole paper
 * thrown away in the browser.
 *
 * Four reads fail SOFT (a page that still renders). The ATTEMPT does not: with
 * no sitting there is nowhere to put an answer, and a player that silently
 * drops answers is worse than a page that says it is not ready. That is also
 * how a locked test ends up saying so: the insert is refused by Postgres, the
 * attempt is null, and the page shows the "not set up" line instead of a
 * player with nothing in it.
 */
import type { AuthSession } from '@/lib/auth/types';
import { attemptsClient } from '@/lib/attempts/student-page';
import type { AttemptMode } from '@/lib/attempts/types';
import type { Exam } from '@/lib/exams/types';
import type { LangMode } from '@/lib/i18n';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import type { MockTest } from '@/lib/mocks/types';
import { createSupabaseQuestionsClient } from '@/lib/questions/supabase-questions-client';
import type { Question } from '@/lib/questions/types';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';
import {
  DEFAULT_MARKING,
  markingOf,
  practiceHeading,
  type MockPracticeData,
} from './types';

function clientOptions(session: AuthSession | null) {
  return {
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  };
}

function mocksClient(session: AuthSession | null) {
  return createSupabaseMocksClient(clientOptions(session));
}

function questionsClient(session: AuthSession | null) {
  return createSupabaseQuestionsClient(clientOptions(session));
}

const EMPTY: MockPracticeData = {
  questions: [],
  attempt: null,
  answers: [],
  marking: DEFAULT_MARKING,
  heading: '',
  examOpen: false,
};

export interface MockPracticeOptions {
  /** `practice` in this slice. `exam` is issue 18 and is not started here. */
  mode: AttemptMode;
  /** Null for the full paper, which is the default (V12, F-E3). */
  topicId: string | null;
  /** The student's saved language, for the exam name in the heading. */
  langMode: LangMode;
}

/**
 * The questions, the sitting, its answers so far, the exam's marking and the
 * line above the progress bar.
 *
 * The sitting is RESUMED when one is open for the SAME test, mode and topic,
 * so re-opening the player does not lose what the student already answered and
 * does not leave a trail of empty attempts. Switching the topic is a NEW
 * sitting, because the two hold different questions.
 */
export async function readMockPracticeData(
  session: AuthSession | null,
  testId: string,
  { mode, topicId, langMode }: MockPracticeOptions,
): Promise<MockPracticeData> {
  if (!session) return EMPTY;

  const mocks = mocksClient(session);

  // The test first: its SET is what leads to the exam whose marking scores the
  // sitting (F-E6), and the player is reached by test id alone.
  const test = await (mocks.readTest?.(testId) ?? Promise.resolve(null)).catch(
    () => null as MockTest | null,
  );

  // WITH THE KEY MATERIAL, and that is the gate (issues 30-exam-key-lock and
  // 36-exam-leaks-close). D3 shows the result after every tap, so practice
  // cannot work without the key, and `question_keys()` REFUSES it while an
  // exam sitting of this same test is open. The teacher's prose travels the
  // same way now, through `question_explanations()`, and raises the same
  // refusal. `ExamKeyLocked` is caught apart from every other failure,
  // because "finish your exam first" and "not set up yet" are different
  // sentences.
  let examOpen = false;
  const [questions, exams, set] = await Promise.all([
    (
      questionsClient(session).listForTest?.(testId, topicId, { keys: true }) ??
      Promise.resolve([])
    ).catch((cause: unknown) => {
      if ((cause as Error)?.name === 'ExamKeyLocked') examOpen = true;
      return [] as Question[];
    }),
    readExamCatalogue(session).catch(() => [] as Exam[]),
    test ? mocks.readOne(test.setId).catch(() => null) : Promise.resolve(null),
  ]);

  const exam = set ? exams.find((one) => one.id === set.examId) : undefined;
  const marking = markingOf(exam ?? null);
  const heading = practiceHeading(test, exam ?? null, langMode);

  // No sitting is even attempted while the exam is open: Postgres would
  // refuse the insert (`attempts_no_practice_during_exam`), and a request we
  // already know the answer to is a request not worth making.
  if (examOpen) return { ...EMPTY, marking, heading, examOpen: true };

  const client = attemptsClient(session);
  const attempt = await (
    client.openOrStartForTest?.({ testId, mode, topicId }) ?? Promise.resolve(null)
  ).catch(() => null);
  if (!attempt) {
    return { questions, attempt: null, answers: [], marking, heading, examOpen: false };
  }

  const answers = await client.listAnswers(attempt.id).catch(() => new Map());
  return {
    questions,
    attempt,
    answers: [...answers.entries()],
    marking,
    heading,
    examOpen: false,
  };
}
