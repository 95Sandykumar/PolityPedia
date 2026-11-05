/**
 * The exam-mode contract for mock tests (issue 18-exam-mode).
 *
 * F-E5 AND D2 IN TWO SENTENCES:
 *
 *  * EXAM MODE: the student sits the test under a clock. No verdict, no right
 *    answer and no explanation is on screen until they submit, the timer turns
 *    amber under 5 minutes, and tapping the progress bar opens a
 *    question-number grid (answered, marked, not seen).
 *  * THE ANSWER KEY NEVER REACHES THE PHONE BEFORE SUBMIT. `correct_idx` and
 *    `teacher_explanation` are stripped out of the load payload while the
 *    sitting is open, so there is nothing on the device to read with the
 *    developer tools. The score is then worked out by `score_attempt()` in
 *    Postgres, which reads the key itself (`0018_exam_mode.sql`).
 *
 * Everything in this file is PURE. The reads live in `student-page.ts`, the
 * route rules in `exam-route.ts`, and Supabase stays behind the interfaces at
 * the bottom, so no test here makes a network call or holds a key
 * (web/CLAUDE.md).
 *
 * THE CLOCK ON SCREEN IS A COURTESY, NOT THE GATE. `remainingMs` draws a
 * timer; `attempt_answers_insert_open` and `attempt_answers_update_open` in
 * Postgres are what actually refuse a late answer. A student who changes the
 * device clock gets a prettier countdown and writes nothing.
 */
import type { Attempt, AttemptAnswer } from '@/lib/attempts/types';
import type { Marking } from '@/lib/practice/types';
import { MOCK_TOPIC_ALL } from '@/lib/set-access/types';
import { OPTION_COUNT, type Question } from '@/lib/questions/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The mode this slice runs. Spelled once, so a link and a read agree. */
export const EXAM_MODE = 'exam';

// --------------------------------------------------------------------------
// F-E5: the question a phone is allowed to see
// --------------------------------------------------------------------------

/**
 * A question with the ANSWER KEY taken out.
 *
 * `Omit`, not a hand-written interface, on purpose: a field added to
 * `Question` later arrives here automatically, and the only way to leak a key
 * is to add a new key FIELD, which the test in `__tests__/types.test.ts`
 * catches by searching the whole serialised payload.
 */
export type ExamQuestion = Omit<Question, 'correctIdx' | 'teacherExplanation'>;

/**
 * One question, minus the key.
 *
 * Built by LISTING what the student needs rather than by deleting two fields
 * off a copy. A list fails safe: a key field added to `Question` next month is
 * absent here until somebody adds it on purpose.
 */
export function stripAnswerKey(question: Question): ExamQuestion {
  return {
    id: question.id,
    teacherId: question.teacherId,
    paperId: question.paperId,
    testId: question.testId,
    number: question.number,
    stem: question.stem,
    options: question.options,
    topicId: question.topicId,
    lang: question.lang,
    imagePath: question.imagePath,
    checked: question.checked,
    status: question.status,
  };
}

/**
 * The question list for the load payload.
 *
 * `revealed` is TRUE only once the sitting has been submitted, which is the
 * whole of design.md's "Exam mode key: strip until submit". The review screen
 * is the same component reading the same route; what changed is that Postgres
 * now has a `submitted_at`.
 */
export function examQuestions(
  questions: readonly Question[],
  revealed: boolean,
): (Question | ExamQuestion)[] {
  if (revealed) return [...questions];
  return questions.map(stripAnswerKey);
}

/** Both spellings of both key fields: the app's camelCase and Postgres's. */
const KEY_FIELDS = ['correctIdx', 'correct_idx', 'teacherExplanation', 'teacher_explanation'];

/**
 * True when a payload carries the answer key anywhere inside it.
 *
 * The LAST line of defence, used by `exam-route.ts` right before it replies:
 * `examQuestions` is the rule, and this is the check that the rule held. It is
 * cheap (one walk of an object we just built) and it is the difference between
 * "we strip the key" and "we can prove the key is not there".
 */
export function carriesAnswerKey(payload: unknown, depth = 0): boolean {
  // A payload this deep is not one of ours. Stops a cycle turning into a hang.
  if (depth > 8 || payload === null || typeof payload !== 'object') return false;

  if (Array.isArray(payload)) {
    return payload.some((one) => carriesAnswerKey(one, depth + 1));
  }

  for (const [key, value] of Object.entries(payload)) {
    if (KEY_FIELDS.includes(key)) return true;
    if (carriesAnswerKey(value, depth + 1)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// The timer
// --------------------------------------------------------------------------

/** DESIGN.md section 8: the timer turns amber UNDER 5 minutes. */
export const AMBER_MS = 5 * 60 * 1000;

/** `mock_tests.duration_min`'s own default, so a missing test still has a clock. */
export const DEFAULT_DURATION_MIN = 60;

/** The band `mock_tests_duration_check` allows: 1 minute to 6 hours. */
export const MIN_DURATION_MIN = 1;
export const MAX_DURATION_MIN = 360;

/**
 * A duration we are willing to put on a clock.
 *
 * Anything outside the band Postgres allows falls back to the DEFAULT rather
 * than being clamped: a clamp would quietly give a student 6 hours for a test
 * whose duration row is broken, and an hour is the number the column itself
 * defaults to.
 */
export function readDurationMin(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_DURATION_MIN;
  if (raw < MIN_DURATION_MIN || raw > MAX_DURATION_MIN) return DEFAULT_DURATION_MIN;
  return raw;
}

/**
 * When the clock runs out: the start plus the duration, as ISO text.
 *
 * The SERVER computes this and Postgres stores it, so the deadline is one
 * value both sides agree on. The browser only ever subtracts.
 */
export function deadlineFor(durationMin: number, now: number = Date.now()): string {
  const minutes = readDurationMin(durationMin);
  return new Date(now + minutes * 60 * 1000).toISOString();
}

/**
 * Milliseconds left, or null when there is no clock (practice mode).
 *
 * Never negative, so the screen cannot draw "-02:14". An UNREADABLE deadline
 * reads as no time left: failing the other way would hand a student an
 * unlimited timed paper off a broken timestamp.
 */
export function remainingMs(deadlineAt: string | null, now: number = Date.now()): number | null {
  if (deadlineAt === null) return null;
  const at = Date.parse(deadlineAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - now);
}

/** How the timer reads: normal, the amber warning, or time up. */
export type TimerTone = 'calm' | 'amber' | 'over';

export function timerTone(remaining: number | null): TimerTone {
  if (remaining === null) return 'calm';
  if (remaining <= 0) return 'over';
  return remaining < AMBER_MS ? 'amber' : 'calm';
}

/**
 * "05:00", or "1:30:00" for a paper longer than an hour.
 *
 * Latin digits and a colon (DESIGN.md section 1). Rounded DOWN, so the clock
 * never shows a second the student does not actually have.
 */
export function timerLabel(remaining: number): string {
  const left = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining / 1000)) : 0;
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  const pad = (one: number) => String(one).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// --------------------------------------------------------------------------
// The question-number grid (D2)
// --------------------------------------------------------------------------

/** The three buckets DESIGN.md section 8 names: answered, marked, not seen. */
export type GridState = 'answered' | 'marked' | 'unseen';

/**
 * One question's square in the grid.
 *
 * MARKED WINS over answered when a question is both, because the grid exists
 * so a student can find the ones they meant to come back to. An answered
 * question they are happy with is not what they are hunting for.
 */
export function gridState(answer: AttemptAnswer | undefined): GridState {
  if (!answer) return 'unseen';
  if (answer.marked) return 'marked';
  return answer.chosenIdx === null ? 'unseen' : 'answered';
}

export function gridStates(
  questions: readonly { id: string }[],
  answers: ReadonlyMap<string, AttemptAnswer>,
): GridState[] {
  return questions.map((one) => gridState(answers.get(one.id)));
}

// --------------------------------------------------------------------------
// The write: an answer with no verdict
// --------------------------------------------------------------------------

/**
 * One exam answer on its way from the player to the server.
 *
 * THERE IS NO `isCorrect` FIELD, and that is the design. The phone was never
 * given `correct_idx`, so it cannot have an opinion, and a route with no field
 * for one cannot be talked into storing a student's own marking.
 */
export interface ExamAnswer {
  attemptId: string;
  questionId: string;
  /** Null when the question is only marked for later. Otherwise 0 to 3. */
  chosenIdx: number | null;
  marked: boolean;
}

/**
 * Validate anything into an `ExamAnswer`, or null.
 *
 * Only the four fields above are carried over, so an `isCorrect`, a `score` or
 * a `userId` in the body is DROPPED right here rather than refused: a caller
 * who sends one gets their answer stored and no hint that we looked. Who owns
 * the attempt is decided by RLS over the session token, never by a field.
 */
export function readExamAnswer(body: unknown): ExamAnswer | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;

  // Both ids go into a REST URL, so the shape is checked before that.
  if (typeof raw.attemptId !== 'string' || !UUID_RE.test(raw.attemptId)) return null;
  if (typeof raw.questionId !== 'string' || !UUID_RE.test(raw.questionId)) return null;

  let chosenIdx: number | null = null;
  if (raw.chosenIdx !== null && raw.chosenIdx !== undefined) {
    if (typeof raw.chosenIdx !== 'number' || !Number.isInteger(raw.chosenIdx)) return null;
    if (raw.chosenIdx < 0 || raw.chosenIdx >= OPTION_COUNT) return null;
    chosenIdx = raw.chosenIdx;
  }

  return {
    attemptId: raw.attemptId,
    questionId: raw.questionId,
    chosenIdx,
    // Fails CLOSED: anything that is not exactly `true` is unmarked.
    marked: raw.marked === true,
  };
}

/**
 * A submit body: the attempt id, and NOTHING ELSE.
 *
 * Deliberately not `AttemptSubmit` from issue 13, which carries a `score` the
 * browser worked out. In exam mode the browser cannot work one out, so there
 * is no field for it, and `score_attempt()` in Postgres is the only thing that
 * ever writes `attempts.score` for a timed sitting.
 */
export interface ExamSubmit {
  attemptId: string;
}

export function readExamSubmit(body: unknown): ExamSubmit | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.attemptId !== 'string' || !UUID_RE.test(raw.attemptId)) return null;
  // A `score` in the body is dropped, not refused: the caller gets their
  // sitting marked by the server and no hint that we looked.
  return { attemptId: raw.attemptId };
}

// --------------------------------------------------------------------------
// What the player is handed, and our own routes
// --------------------------------------------------------------------------

/**
 * The load payload.
 *
 * `answers` is an array of pairs and not a Map, so it crosses the server
 * boundary (and JSON) unchanged, the same as `MockPracticeData` in issue 17.
 */
export interface ExamLoad {
  /**
   * The test's live questions for the chosen topic, in number order. STRIPPED
   * while `revealed` is false, which is every moment before submit (F-E5).
   */
  questions: (Question | ExamQuestion)[];
  /** Null when the sitting could not be started: the page then says so. */
  attempt: Attempt | null;
  answers: [string, AttemptAnswer][];
  /** The exam's marking, or the fallback. Never null: a score needs numbers. */
  marking: Marking;
  /** The line above the progress bar. Empty when nothing could be read. */
  heading: string;
  /** The test's own duration, which is what the deadline was built from. */
  durationMin: number;
  /** True once the sitting is submitted. The ONLY state that carries the key. */
  revealed: boolean;
}

/**
 * GET our own load route.
 *
 * `mode=exam` is always written out, even though the route could default to
 * it: the link is also what the mock list builds, and a mode that is spelled
 * out cannot be mistaken for a practice link that lost its query.
 */
export function examLoadPath(
  testId: string,
  options: { topicId?: string | null } = {},
): string {
  const query = new URLSearchParams({ mode: EXAM_MODE });
  // "Full paper" is the absence of a filter, so it is left out of the URL.
  if (options.topicId && options.topicId !== MOCK_TOPIC_ALL) {
    query.set('topic', options.topicId);
  }
  return `/api/tests/${encodeURIComponent(testId)}/load?${query.toString()}`;
}

/** POST one answer of the caller's own timed sitting. Holds no key. */
export function examAnswerPath(testId: string): string {
  return `/api/tests/${encodeURIComponent(testId)}/answer`;
}

/** POST to close the sitting. The SERVER works out the score. */
export function examSubmitPath(testId: string): string {
  return `/api/tests/${encodeURIComponent(testId)}/submit`;
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** Server side. Carries the student's own access token, so RLS decides. */
export interface ExamClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /**
   * The open timed sitting for this test, or a new one with a fresh deadline.
   *
   * RESUMED rather than always inserted, so a student who closes the tab walks
   * back into the SAME clock instead of being handed another full hour.
   */
  openOrStartExam(input: {
    testId: string;
    topicId: string | null;
    durationMin: number;
  }): Promise<Attempt>;
  /** The idempotent upsert, keyed (attempt_id, question_id). No verdict (A1). */
  saveExamAnswer(answer: ExamAnswer): Promise<void>;
  /**
   * `score_attempt()`: the server marks the paper and closes the sitting.
   *
   * Safe to call twice: the second call returns the score already stored, so a
   * retry after a dropped reply never re-marks a closed sitting.
   */
  scoreAttempt(attemptId: string): Promise<number | null>;
}

/** Browser side: the exam player. Calls our own routes, holds no key. */
export interface BrowserExamClient {
  saveAnswer(answer: ExamAnswer): Promise<void>;
  /** Returns the score the SERVER worked out, or null when it could not. */
  submit(attemptId: string): Promise<number | null>;
  /** Re-read the payload. After submit it carries the key, for the review. */
  load(): Promise<ExamLoad | null>;
}
