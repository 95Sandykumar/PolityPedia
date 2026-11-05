/**
 * The server read behind timed EXAM mode (issue 18-exam-mode).
 *
 * Server only. Every read runs HERE, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key. A locked test hands this page ZERO questions
 * (`0016_set_access.sql`) and no sitting at all
 * (`attempts_mock_needs_access` in `0017`).
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * TWO RULES THIS FILE EXISTS FOR:
 *
 *  1. F-E5. The key is NEVER READ while the sitting is open (issue
 *     30-exam-key-lock). `0030_exam_key_lock.sql` revoked the column
 *     privilege on `questions.correct_idx`, so the question read here has no
 *     key in it at all, and `question_keys()` is asked for one only once
 *     Postgres says the sitting is submitted. `examQuestions` still strips
 *     the payload, so the rule is stated twice: one is the rule, the other is
 *     the proof.
 *  2. THE CLOCK STARTS HERE. Opening this read creates the sitting with
 *     `deadline_at = now + duration`, or RESUMES the open one, so a refresh
 *     walks back into the same clock instead of buying another hour.
 *
 * ONE REQUEST FOR THE WHOLE PAPER (DESIGN.md section 10). Every question is
 * read once and handed down, so the player never waits for a round trip
 * between two questions, which matters more under a clock than anywhere else.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { Exam } from '@/lib/exams/types';
import { createSupabaseExamClient } from '@/lib/exam/supabase-exam-client';
import { createSupabaseAttemptsClient } from '@/lib/attempts/supabase-attempts-client';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import type { MockTest } from '@/lib/mocks/types';
import { createSupabaseQuestionsClient } from '@/lib/questions/supabase-questions-client';
import type { Question } from '@/lib/questions/types';
import { DEFAULT_MARKING, markingOf, practiceHeading } from '@/lib/practice/types';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';
import type { ExamLoadOptions } from './exam-route';
import { DEFAULT_DURATION_MIN, examQuestions, readDurationMin, type ExamLoad } from './types';

function clientOptions(session: AuthSession | null) {
  return {
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  };
}

const EMPTY: ExamLoad = {
  questions: [],
  attempt: null,
  answers: [],
  marking: DEFAULT_MARKING,
  heading: '',
  durationMin: DEFAULT_DURATION_MIN,
  revealed: false,
};

/**
 * The exam payload: stripped questions, the timed sitting, its answers so far,
 * the exam's marking, the heading and the duration the clock was built from.
 *
 * Four reads fail SOFT (a page that still renders). The SITTING does not: with
 * no sitting there is nowhere to put an answer, and a timed player that
 * silently drops answers is worse than a page that says it is not ready. That
 * is also how a locked test ends up saying so.
 */
export async function readExamLoad(
  session: AuthSession | null,
  testId: string,
  { topicId, langMode }: ExamLoadOptions,
): Promise<ExamLoad> {
  if (!session) return EMPTY;

  const mocks = createSupabaseMocksClient(clientOptions(session));

  // The test first, for TWO reasons now: its set leads to the exam whose
  // marking scores the sitting (F-E6), and its `duration_min` is the clock.
  const test = await (mocks.readTest?.(testId) ?? Promise.resolve(null)).catch(
    () => null as MockTest | null,
  );
  const durationMin = readDurationMin(test?.durationMin ?? DEFAULT_DURATION_MIN);

  const questionsClient = createSupabaseQuestionsClient(clientOptions(session));

  const [questions, exams, set] = await Promise.all([
    // NO KEYS. Not "keys that are thrown away later": none are fetched, so
    // there is no moment at which this server holds the answer key of a
    // paper somebody is still sitting (F-E5).
    (
      questionsClient.listForTest?.(testId, topicId, { keys: false }) ?? Promise.resolve([])
    ).catch(() => [] as Question[]),
    readExamCatalogue(session).catch(() => [] as Exam[]),
    test ? mocks.readOne(test.setId).catch(() => null) : Promise.resolve(null),
  ]);

  const exam = set ? exams.find((one) => one.id === set.examId) : undefined;
  const marking = markingOf(exam ?? null);
  const heading = practiceHeading(test, exam ?? null, langMode);

  const attempt = await createSupabaseExamClient(clientOptions(session))
    .openOrStartExam({ testId, topicId, durationMin })
    .catch(() => null);

  if (!attempt) {
    return { ...EMPTY, questions: examQuestions(questions, false), marking, heading, durationMin };
  }

  // THE ONE LINE F-E5 TURNS ON. The key is handed over only once Postgres says
  // the sitting is closed, which it says by having a `submitted_at`. Nothing
  // the browser sent is part of that decision.
  const revealed = attempt.submittedAt !== null;

  const [answers, keys] = await Promise.all([
    createSupabaseAttemptsClient(clientOptions(session))
      .listAnswers(attempt.id)
      .catch(() => new Map()),
    // THE REVIEW, and only the review, asks for the key. Postgres agrees
    // twice over: the sitting is submitted, so `question_keys()` no longer
    // refuses (issue 30-exam-key-lock). A failure here costs the green ticks
    // on the review, never the score, so it fails soft.
    revealed && questions.length > 0
      ? (questionsClient.readKeys?.(questions.map((one) => one.id)) ??
          Promise.resolve(new Map<string, number>())
        ).catch(() => new Map<string, number>())
      : Promise.resolve(new Map<string, number>()),
  ]);

  const reviewed = revealed
    ? questions.map((one) => ({ ...one, correctIdx: keys.get(one.id) ?? null }))
    : questions;

  return {
    questions: examQuestions(reviewed, revealed),
    attempt,
    answers: [...answers.entries()],
    marking,
    heading,
    durationMin,
    revealed,
  };
}
