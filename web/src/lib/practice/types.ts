/**
 * The practice-mode contract for mock tests (issue 17-practice-mode).
 *
 * F-E4 and F-E6 in two sentences:
 *
 *  * PRACTICE MODE: the student starts a mock test with no timer, answers the
 *    FULL PAPER or ONE TOPIC, sees right or wrong at once (D3), and gets a
 *    score at the end. The player component is the one issue 13 wrote; this
 *    slice only hands it a marking scheme and a filtered question list.
 *  * MARKING PER EXAM: a score is MARKS, not a count of right answers. The
 *    numbers come from `exams.marks_correct` and `exams.marks_wrong`, which is
 *    where a change to a real exam's scheme has to land.
 *
 * Everything in this file is PURE. The reads live in `student-page.ts`, and
 * Supabase stays behind the interfaces the other modules already own, so no
 * test here makes a network call or holds a key (web/CLAUDE.md).
 *
 * NOT HERE: the timer (issue 18-exam-mode). `readRequestedMode` reads `exam`
 * out of the link so issue 18 can take over without moving the link, and this
 * slice refuses to pretend it can run one.
 */
import type { Attempt, AttemptAnswer, AttemptMode } from '@/lib/attempts/types';
import { isAttemptMode } from '@/lib/attempts/types';
import type { LangMode } from '@/lib/i18n';
import type { Question } from '@/lib/questions/types';
import { MOCK_TOPIC_ALL } from '@/lib/set-access/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Full paper" is the default and is NOT a topic id, so it is a word.
 *
 * Re-exported from `set-access` rather than spelled again: the mock list
 * writes this value into the link and this slice reads it back, so one typo in
 * two files would silently load the wrong questions.
 */
export { MOCK_TOPIC_ALL };

/** The two numbers one exam scores a paper with (F-E6). */
export interface Marking {
  /** Marks for a right answer. Always more than zero. */
  marksCorrect: number;
  /** Marks for a wrong answer. Zero, or negative. Never positive. */
  marksWrong: number;
}

/**
 * What an exam with no published scheme is scored with: one mark a question
 * and no negative marking.
 *
 * PGT and TGT marking is unknown (PRD section 6), and UGC NET is unverified
 * (AS5). Scoring an unknown scheme at ZERO would hand a student a 0 out of 0
 * for a paper they got right, so the fallback is the plain count of right
 * answers, which is exactly what the player showed before this slice.
 */
export const DEFAULT_MARKING: Marking = { marksCorrect: 1, marksWrong: 0 };

/** Just the two columns, so a test does not have to build a whole `Exam`. */
export interface ExamMarking {
  marksCorrect: number | null;
  marksWrong: number | null;
}

/**
 * One exam's marking, with each half defaulted on its own.
 *
 * Three refusals, because a marking scheme decides a student's score:
 *
 *  * `marks_correct` of zero or less would score every paper at zero, so it
 *    falls back to one mark.
 *  * `marks_wrong` above zero would PAY for a wrong answer, so it is clamped
 *    to no penalty rather than trusted.
 *  * anything that is not a finite number is treated as missing.
 */
export function markingOf(exam: ExamMarking | null | undefined): Marking {
  const rawCorrect = exam?.marksCorrect;
  const rawWrong = exam?.marksWrong;

  const marksCorrect =
    typeof rawCorrect === 'number' && Number.isFinite(rawCorrect) && rawCorrect > 0
      ? rawCorrect
      : DEFAULT_MARKING.marksCorrect;

  const marksWrong =
    typeof rawWrong === 'number' && Number.isFinite(rawWrong) && rawWrong < 0
      ? rawWrong
      : DEFAULT_MARKING.marksWrong;

  return { marksCorrect, marksWrong };
}

/**
 * The score of one sitting, in MARKS.
 *
 * A question with no chosen option scores nothing either way, marked or not:
 * an unattempted question is not a wrong answer, and negative marking must
 * never punish a student for leaving one out.
 *
 * ROUNDED to a whole mark, because `attempts.score` is an `integer` column and
 * `readAttemptSubmit` refuses anything else. A third-of-a-mark scheme would
 * otherwise be refused by our own route.
 */
export function scoreAnswers(
  answers: ReadonlyMap<string, AttemptAnswer>,
  marking: Marking = DEFAULT_MARKING,
): number {
  let total = 0;
  for (const one of answers.values()) {
    if (one.isCorrect === true) total += marking.marksCorrect;
    else if (one.isCorrect === false) total += marking.marksWrong;
  }
  return Math.round(total);
}

/** What the paper is out of: its marks, never its question count. */
export function totalMarks(
  questionCount: number,
  marking: Marking = DEFAULT_MARKING,
): number {
  if (!Number.isFinite(questionCount) || questionCount <= 0) return 0;
  return Math.round(questionCount * marking.marksCorrect);
}

/**
 * The topic out of the player's query, or null for the full paper.
 *
 * The value ends up in a REST filter, so anything that is not a uuid is
 * dropped here rather than sent. `all` is the word the mock list writes for
 * "Full paper", and the absence of a filter is what it means.
 */
export function readTopicFilter(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text === MOCK_TOPIC_ALL) return null;
  return UUID_RE.test(text) ? text : null;
}

/**
 * The mode out of the player's query. `practice` unless the link says `exam`.
 *
 * Fails to PRACTICE, which is the mode with no timer: a broken query that
 * started a timed sitting would take time away from a student who never asked
 * for one.
 */
export function readRequestedMode(raw: unknown): AttemptMode {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isAttemptMode(value) ? value : 'practice';
}

/** Just the two name columns, so a test does not have to build a whole `Exam`. */
export interface ExamNames {
  nameEn: string;
  nameHi: string;
}

/**
 * The 14 px muted line above the progress bar (DESIGN.md section 8): the exam
 * name, then the test name.
 *
 * `both` puts the two exam names on ONE line, the same as `examNameOf` does
 * for a past paper, because the header is a single row and not a stacked
 * label. With no exam it is the test name on its own, never a blank line.
 */
export function practiceHeading(
  test: { title: string } | null | undefined,
  exam: ExamNames | null | undefined,
  mode: LangMode,
): string {
  const title = test?.title?.trim() ?? '';
  if (!exam) return title;

  const name =
    mode === 'both'
      ? [exam.nameEn, exam.nameHi].filter((one) => one.length > 0).join(' / ')
      : mode === 'hi'
        ? exam.nameHi
        : exam.nameEn;

  return [name, title].filter((one) => one.length > 0).join(' · ');
}

/**
 * What the mock player page hands the player.
 *
 * `answers` is an array of pairs and not a Map, so it crosses the server
 * boundary unchanged, the same as `PracticeData` in issue 13.
 */
export interface MockPracticeData {
  /** The test's live questions for the chosen topic, in number order. */
  questions: Question[];
  /** Null when the sitting could not be started: the page then says so. */
  attempt: Attempt | null;
  answers: [string, AttemptAnswer][];
  /** The exam's marking, or the fallback. Never null: a score needs numbers. */
  marking: Marking;
  /** The line above the progress bar. Empty when nothing could be read. */
  heading: string;
}
