/**
 * The attempts contract (issue 13-question-player).
 *
 * One sitting of a paper is an `attempt`; one answer in it is an
 * `attempt_answer`, keyed `(attemptId, questionId)`.
 *
 * A1, THE RULE THIS FILE EXISTS FOR: the write is an UPSERT and it is
 * idempotent. The player writes straight from a phone on 4G and keeps a retry
 * queue, so the same answer WILL arrive twice. The key is in
 * `0013_attempts.sql`; everything here is shaped so nothing ever invents a
 * second key for the same question.
 *
 * Supabase sits behind the interfaces at the bottom, so tests fake them: no
 * real network call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 *  * `AttemptsClient`        -- server side, carries the student's own access
 *                               token, so Postgres RLS (`attempts_*`) decides.
 *  * `BrowserAttemptsClient` -- the player. Posts to our own route, holds no key.
 *  * `AnswerQueue`           -- the offline retry queue (`answer-queue.ts`).
 *
 * The validation below is a COPY of the SQL constraints in 0013, on purpose:
 * the database is the gate, and this keeps a bad shape out of the REST call.
 */
import { OPTION_COUNT, type QuestionOptions } from '@/lib/questions/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Practice shows the result at once (D3); exam keeps it to the end and runs a
 * timer. Mock-test modes are issues 17 and 18: the column and the player are
 * shared, so neither needs a migration then.
 */
export type AttemptMode = 'practice' | 'exam';

export const ATTEMPT_MODES: readonly AttemptMode[] = ['practice', 'exam'];

export function isAttemptMode(value: unknown): value is AttemptMode {
  return typeof value === 'string' && (ATTEMPT_MODES as readonly string[]).includes(value);
}

/** One row of `attempts`. */
export interface Attempt {
  id: string;
  userId: string;
  /** Set for a past-paper sitting. Null for a mock test (issue 15). */
  paperId: string | null;
  testId: string | null;
  mode: AttemptMode;
  topicId: string | null;
  /** Exam mode only: when the timer runs out. ISO text, or null. */
  deadlineAt: string | null;
  /** Null while the sitting is open. */
  submittedAt: string | null;
  score: number | null;
}

/** What the player knows about one question in this sitting. */
export interface AttemptAnswer {
  /** Null when the question is only marked for later. */
  chosenIdx: number | null;
  /** Null when there is no chosen option, the same rule as the CHECK in 0013. */
  isCorrect: boolean | null;
  marked: boolean;
}

/** One upsert, on its way from the player to the server. */
export interface AnswerUpsert extends AttemptAnswer {
  attemptId: string;
  questionId: string;
}

/** A B C D. Letters, never numbers: the badge on each option button. */
export const OPTION_LETTERS: readonly string[] = ['A', 'B', 'C', 'D'];

export function optionLetter(index: number): string {
  return OPTION_LETTERS[index] ?? '';
}

/**
 * "12 / 100". Latin digits and a slash (DESIGN.md section 1), one-based,
 * because a student counts from 1.
 *
 * An empty paper reads "0 / 0" rather than "1 / 0", which would be a lie about
 * a question that is not there.
 */
export function progressLabel(index: number, total: number): string {
  if (total <= 0) return '0 / 0';
  const shown = Math.min(index + 1, total);
  return `${shown} / ${total}`;
}

/** The verdict at the moment of answering. Stored, never recomputed on read. */
export function verdictOf(correctIdx: number, chosenIdx: number): boolean {
  return correctIdx === chosenIdx;
}

/** Right answers in this sitting. A marked-only question is neither. */
export function countCorrect(answers: ReadonlyMap<string, AttemptAnswer>): number {
  let total = 0;
  for (const one of answers.values()) if (one.isCorrect === true) total += 1;
  return total;
}

/**
 * The player's own URL, so Back works and a question page can be shared
 * (DESIGN.md section 7).
 */
export function playerPath(teacherId: string, paperId: string): string {
  return `/t/${encodeURIComponent(teacherId)}/papers/${encodeURIComponent(paperId)}/play`;
}

/** Our own route the player posts an answer to. Holds no key. */
export const ATTEMPT_ANSWERS_PATH = '/api/attempts/answers';

/** Our own route that closes a sitting. */
export const ATTEMPT_SUBMIT_PATH = '/api/attempts/submit';

/**
 * Our own route the result page reads (issue 56-result-page).
 *
 * The attempt id is in the PATH and nothing else is sent, because nothing else
 * would be believed: `attempts_select_own` (0013) decides whose sitting this
 * is from the session token, so a student who edits the id sees the same
 * "nothing to show" a missing id gets.
 */
export function attemptResultPath(attemptId: string): string {
  return `/api/attempts/${encodeURIComponent(attemptId)}/result`;
}

/**
 * Validate anything into an `AnswerUpsert`, or null.
 *
 * Only the five fields below are carried over, so a `userId` or a `score` in
 * the body is DROPPED right here rather than refused: a caller who sends one
 * gets their answer stored and no hint that we looked. Who owns the attempt is
 * decided by RLS over the session token, never by a field.
 */
export function readAnswerUpsert(body: unknown): AnswerUpsert | null {
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

  let isCorrect: boolean | null = null;
  if (raw.isCorrect !== null && raw.isCorrect !== undefined) {
    if (typeof raw.isCorrect !== 'boolean') return null;
    isCorrect = raw.isCorrect;
  }

  // `attempt_answers_verdict_check`: a verdict without a chosen option, or a
  // chosen option with no verdict, is a bug upstream and not a state.
  if ((chosenIdx === null) !== (isCorrect === null)) return null;

  return {
    attemptId: raw.attemptId,
    questionId: raw.questionId,
    chosenIdx,
    isCorrect,
    // Fails CLOSED: anything that is not exactly `true` is unmarked.
    marked: raw.marked === true,
  };
}

/** Validate a submit body: the attempt id plus the score. */
export interface AttemptSubmit {
  attemptId: string;
  score: number;
}

export function readAttemptSubmit(body: unknown): AttemptSubmit | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;

  if (typeof raw.attemptId !== 'string' || !UUID_RE.test(raw.attemptId)) return null;
  if (typeof raw.score !== 'number' || !Number.isInteger(raw.score)) return null;
  // A score is marks, so a negative one is real (negative marking). The cap is
  // the question limit of one paper.
  if (raw.score < -800 || raw.score > 800) return null;

  return { attemptId: raw.attemptId, score: raw.score };
}

// --------------------------------------------------------------------------
// The interfaces every outside service hides behind
// --------------------------------------------------------------------------

/** Server side. Carries the student's own access token, so RLS decides. */
export interface AttemptsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /**
   * The open sitting for this paper, or a new one.
   *
   * Resumes rather than always inserting, so re-opening the player (or a
   * double render in dev) does not leave a trail of empty attempts.
   */
  openOrStartForPaper(input: {
    paperId: string;
    mode: AttemptMode;
    topicId?: string | null;
  }): Promise<Attempt>;
  /**
   * The same thing for a MOCK TEST (issue 17-practice-mode).
   *
   * The topic is part of what is resumed, not just stored: a sitting of the
   * full paper holds different questions from a sitting of one topic, so
   * switching the Topic dropdown starts a NEW sitting instead of resuming one
   * whose answers belong to other questions.
   *
   * OPTIONAL, so every fake written for issue 13 is still a whole
   * `AttemptsClient`. Call it as `client.openOrStartForTest?.(...)`.
   */
  openOrStartForTest?(input: {
    testId: string;
    mode: AttemptMode;
    topicId?: string | null;
  }): Promise<Attempt>;
  /** The answers already in that sitting, so the player opens where it was. */
  listAnswers(attemptId: string): Promise<Map<string, AttemptAnswer>>;
  /** The idempotent upsert. Safe to call with the same answer twice (A1). */
  saveAnswer(answer: AnswerUpsert): Promise<void>;
  /** Close the sitting: `submitted_at` and `score`, once. */
  submit(input: AttemptSubmit): Promise<void>;
}

/** Browser side: the player. Calls our own routes, holds no key. */
export interface BrowserAttemptsClient {
  saveAnswer(answer: AnswerUpsert): Promise<void>;
  submit(input: AttemptSubmit): Promise<void>;
}

/**
 * The offline retry queue. Built in `answer-queue.ts`, an interface here so
 * the player takes a fake one in tests.
 */
export interface AnswerQueue {
  /** Queue one answer and try to send it now. NEVER throws. */
  push(answer: AnswerUpsert): Promise<void>;
  /** Retry everything still waiting. Called on the `online` event. */
  flush(): Promise<void>;
  /** How many answers are still waiting. The offline banner reads this. */
  pending(): number;
  /** Called whenever `pending()` changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

// --------------------------------------------------------------------------
// The result read (issue 56a-result-reader)
// --------------------------------------------------------------------------
//
// What a student sees once a sitting is CLOSED: the score, the counts, the
// time it took, and the questions they got wrong. The reader is `result.ts`;
// the screen is ticket 56.
//
// TWO DATABASE RULES ARE SHAPED INTO THESE TYPES, so a caller cannot get them
// wrong by accident:
//
//  * `AttemptResult.score` is the number `score_attempt()` STORED (0031). It
//    is read, never worked out again from the answers, so a moderation fix or
//    a marking scheme this code knows nothing about still shows correctly.
//  * `ResultWrongQuestion.right` is nullable because the answer key comes from
//    `question_keys()` (0030), which refuses the call while the caller has an
//    open exam sitting of the same test. Null means "locked right now", not
//    "there is no right answer", and the screen can say so.

/** One option of a question, as a result page shows it. */
export interface ResultOption {
  /** 0 to 3, an index into the question options. */
  idx: number;
  /** A B C D. The badge the student saw on the button. */
  letter: string;
  text: string;
}

/** One question the student got wrong, in paper order. */
export interface ResultWrongQuestion {
  questionId: string;
  /** The number in the paper, one-based: the number the student saw. */
  number: number;
  /** The stem, folded to one line and cut (`shortStem`). */
  stem: string;
  /** What the student chose. A wrong answer always has one. */
  chosen: ResultOption;
  /** The right answer, or null while `question_keys()` is locked (0030). */
  right: ResultOption | null;
}

/** Everything a result page needs for one submitted sitting. */
export interface AttemptResult {
  attemptId: string;
  mode: AttemptMode;
  /** The SERVER-stored score, marks after negative marking. Never recomputed. */
  score: number;
  /** Questions in the sitting. `right + wrong + skipped` is exactly this. */
  total: number;
  /** Right answers as a whole percentage of `total`. 0 for an empty paper. */
  percent: number;
  right: number;
  wrong: number;
  /** Not answered: untouched, or marked for later and left. */
  skipped: number;
  /** Whole seconds between the start and the close. Never negative. */
  timeTakenSec: number;
  /** True when the close happened at or after the exam deadline. */
  autoSubmitted: boolean;
  wrongQuestions: ResultWrongQuestion[];
}

/** The `attempts` row this read needs. `startedAt` is here for the time taken. */
export interface ResultAttempt {
  id: string;
  userId: string;
  paperId: string | null;
  testId: string | null;
  mode: AttemptMode;
  topicId: string | null;
  startedAt: string;
  deadlineAt: string | null;
  /** Null while the sitting is open, and then there is no result at all. */
  submittedAt: string | null;
  score: number | null;
}

/** One question of the sitting. No `correctIdx`: that is `readKeys` only (0030). */
export interface ResultQuestion {
  id: string;
  number: number;
  stem: string;
  options: QuestionOptions;
}

/**
 * Where the result read gets its rows.
 *
 * A port, not a client, for one reason: three of the four rules in this slice
 * are enforced by Postgres (RLS, a revoked column privilege, a definer
 * function), so the test drives these four methods against a real database and
 * the rules are proven instead of imitated.
 */
export interface ResultSource {
  /** The sitting, or NULL when RLS hides it: it is another student's. */
  readAttempt(attemptId: string): Promise<ResultAttempt | null>;
  /** The questions of this sitting, in paper order. */
  readQuestions(attempt: ResultAttempt): Promise<ResultQuestion[]>;
  /** The stored answers, keyed by question id. */
  readAnswers(attemptId: string): Promise<Map<string, AttemptAnswer>>;
  /**
   * `question_keys()`: the right answer for the ids asked. Called only for a
   * SUBMITTED sitting, and only for the questions answered wrong. An empty map
   * is a valid answer and means the key is locked (0030).
   */
  readKeys(questionIds: readonly string[]): Promise<Map<string, number>>;
}
