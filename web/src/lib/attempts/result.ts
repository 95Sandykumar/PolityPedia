/**
 * The result of ONE SUBMITTED sitting (issue 56a-result-reader).
 *
 * `readAttemptResult()` answers the question the result screen asks: how did
 * this sitting go? The score, the counts, the time it took, and the questions
 * the student got wrong with the right answer beside each one. Ticket 56 draws
 * it; nothing here knows what a pixel is.
 *
 * FOUR RULES, AND THREE OF THEM BELONG TO POSTGRES:
 *
 *  1. THE SCORE IS READ, NEVER WORKED OUT AGAIN (0031). `score_attempt()`
 *     marked the sitting on the server with the exam's own scheme and stored
 *     one number. This file repeats that number. It counts right and wrong
 *     answers for the breakdown, but it never turns those counts back into a
 *     score: a marking scheme this code has not got, or a moderation fix on a
 *     bad question, would quietly disagree with the mark the student has
 *     already seen.
 *  2. A RESULT EXISTS ONLY AFTER THE CLOSE (0030). No `submitted_at`, no
 *     result and no key read: `question_keys()` is the one way to the answer
 *     key and it is shut while an exam sitting is open, so the reader does not
 *     even ask. An open sitting returns null.
 *  3. ANOTHER STUDENT'S SITTING IS NOT HIDDEN HERE. `attempts_select_own`
 *     (0013) hides it. The port below returns null for a row RLS did not hand
 *     over, and this file treats null as "no result", not as an error, because
 *     the two are indistinguishable from outside and should be.
 *  4. THE KEY IS ALL OR NOTHING. `question_keys()` RAISES while the caller has
 *     an open exam sitting of the same test (F-E5), which is a real state: a
 *     student can open the exam in a second tab and then look at an older
 *     result. The wrong question is still listed, with `right: null`, and the
 *     screen says the key is locked. Nothing is invented.
 *
 * An auto-submit at the deadline is NOT a special case. It is the same
 * `score_attempt()` call, so the shape is the same, and `autoSubmitted` says
 * the clock closed it rather than the student.
 *
 * Supabase sits behind `ResultSource` (web/CLAUDE.md), so the test drives the
 * reader against real Postgres through PGlite and the three database rules are
 * proven instead of imitated.
 */
import {
  MAX_QUESTIONS_PER_PAPER,
  readOptions,
  type QuestionOptions,
} from '@/lib/questions/types';
import { readSupabaseEnv } from '@/lib/auth/env';
import { readAnswerRow } from './supabase-attempts-client';
import {
  isAttemptMode,
  optionLetter,
  type AttemptAnswer,
  type AttemptResult,
  type ResultAttempt,
  type ResultOption,
  type ResultQuestion,
  type ResultSource,
  type ResultWrongQuestion,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How much of a stem the wrong list shows.
 *
 * A stem can be 2000 characters (`MAX_STEM_LENGTH`), and the wrong list is a
 * list: one line each, so a student can see the shape of what went wrong
 * before opening anything. The review screen (ticket 57) shows the whole one.
 */
export const SHORT_STEM_LENGTH = 90;

/** The cut mark. One character, so it costs almost nothing of the budget. */
const ELLIPSIS = '…';

/**
 * One line of stem.
 *
 * Two jobs. It FOLDS whitespace, because a stem split out of a PDF carries the
 * newlines and double spaces of the original column, and in a one-line list
 * those come out as gaps. Then it CUTS at a word, because a cut mid-word reads
 * as a typo rather than as "there is more".
 */
export function shortStem(stem: string): string {
  const folded = stem.replace(/\s+/g, ' ').trim();
  if (folded.length <= SHORT_STEM_LENGTH) return folded;

  const head = folded.slice(0, SHORT_STEM_LENGTH);
  const lastSpace = head.lastIndexOf(' ');
  // A single 90-character word has no space to cut at, so the hard cut stands.
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return cut.trimEnd() + ELLIPSIS;
}

/** An index plus the letter and text the student saw, or null for a bad index. */
function optionAt(options: QuestionOptions, idx: number | null): ResultOption | null {
  if (idx === null || !Number.isInteger(idx)) return null;
  const text = options[idx];
  if (typeof text !== 'string') return null;
  return { idx, letter: optionLetter(idx), text };
}

/** Whole seconds between two ISO timestamps. Never negative, never NaN. */
function secondsBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** True when the close landed on or after the deadline: the clock did it. */
function closedOnTheClock(deadlineAt: string | null, submittedAt: string): boolean {
  if (deadlineAt === null) return false;
  const deadline = Date.parse(deadlineAt);
  const submitted = Date.parse(submittedAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(submitted)) return false;
  return submitted >= deadline;
}

/**
 * The result of one sitting, or null.
 *
 * Null covers every "there is nothing to show" at once: the attempt is not
 * this student's (RLS hid the row), it does not exist, or it is still open. A
 * caller cannot tell those apart, and must not: one of them is a privacy
 * answer, and a different reply for each would be the leak.
 */
export async function readAttemptResult(
  source: ResultSource,
  attemptId: string,
): Promise<AttemptResult | null> {
  if (!UUID_RE.test(attemptId)) return null;

  const attempt = await source.readAttempt(attemptId);
  if (!attempt) return null;

  // Rule 2. An open sitting has no result and no key, so the reader stops
  // BEFORE it asks for either.
  const submittedAt = attempt.submittedAt;
  if (!submittedAt) return null;

  const questions = [...(await source.readQuestions(attempt))].sort(
    (a, b) => a.number - b.number,
  );
  const answers = await source.readAnswers(attempt.id);

  let right = 0;
  let wrong = 0;
  let skipped = 0;
  const wrongOnes: { question: ResultQuestion; answer: AttemptAnswer }[] = [];

  // The QUESTIONS lead, not the answers: a question nobody touched has no
  // answer row at all, and it is still a question the student skipped. An
  // answer whose question is not in this sitting (another topic) is ignored
  // for the same reason.
  for (const question of questions) {
    const answer = answers.get(question.id);
    if (answer?.isCorrect === true) {
      right += 1;
    } else if (answer?.isCorrect === false) {
      wrong += 1;
      wrongOnes.push({ question, answer });
    } else {
      // Marked for later and left is skipped, exactly like never opened.
      skipped += 1;
    }
  }

  // Rule 4, and the minimum disclosure: the key is asked for the questions
  // that went wrong and no others. A sitting with nothing wrong asks nothing.
  const keys =
    wrongOnes.length > 0
      ? await source.readKeys(wrongOnes.map((one) => one.question.id))
      : new Map<string, number>();

  const wrongQuestions: ResultWrongQuestion[] = [];
  for (const { question, answer } of wrongOnes) {
    const chosen = optionAt(question.options, answer.chosenIdx);
    // `attempt_answers_verdict_check` (0013) makes this impossible: a verdict
    // of false has a chosen option. Skipped rather than faked, because a wrong
    // answer with no answer in it is not a row to show a student.
    if (!chosen) continue;

    const found = keys.get(question.id);
    wrongQuestions.push({
      questionId: question.id,
      number: question.number,
      stem: shortStem(question.stem),
      chosen,
      right: optionAt(question.options, found === undefined ? null : found),
    });
  }

  const total = questions.length;

  return {
    attemptId: attempt.id,
    mode: attempt.mode,
    // Rule 1. The stored number, repeated. A closed sitting always has one:
    // `score_attempt()` writes `submitted_at` and `score` in one UPDATE.
    score: attempt.score ?? 0,
    total,
    percent: total > 0 ? Math.round((right / total) * 100) : 0,
    right,
    wrong,
    skipped,
    timeTakenSec: secondsBetween(attempt.startedAt, submittedAt),
    autoSubmitted: closedOnTheClock(attempt.deadlineAt, submittedAt),
    wrongQuestions,
  };
}

// --------------------------------------------------------------------------
// The Supabase driver
// --------------------------------------------------------------------------
//
// Plain `fetch` over the Supabase REST API, carrying the SIGNED-IN STUDENT'S
// own access token, so RLS decides every read. No service-role key lives here.
// The env is read lazily inside every call, so importing this file can never
// break a build with no environment variables (web/CLAUDE.md).

const ATTEMPTS = '/rest/v1/attempts';
const ANSWERS = '/rest/v1/attempt_answers';
const QUESTIONS = '/rest/v1/questions';
/** The one way to the answer key (0030). A definer function, so it is an RPC. */
const KEYS = '/rest/v1/rpc/question_keys';

/**
 * Never `select=*`, so a column added later cannot leak by accident, and
 * never `correct_idx` or `teacher_explanation`: 0030 and 0037 revoked both
 * from `authenticated`, so asking for either would fail the whole read.
 */
const ATTEMPT_COLUMNS =
  'id,user_id,paper_id,test_id,mode,topic_id,started_at,deadline_at,submitted_at,score';
const QUESTION_COLUMNS = 'id,number,stem,options';
const ANSWER_COLUMNS = 'question_id,chosen_idx,is_correct,marked';

export interface SupabaseResultSourceOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function whole(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // PostgREST returns a bigint as text, so a numeric string is accepted too.
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** One `attempts` row as the result read needs it, or null. */
export function readResultAttemptRow(raw: unknown): ResultAttempt | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const id = text(row.id);
  const userId = text(row.user_id);
  const startedAt = text(row.started_at);
  if (!id || !userId || !startedAt) return null;
  if (!isAttemptMode(row.mode)) return null;

  return {
    id,
    userId,
    paperId: text(row.paper_id),
    testId: text(row.test_id),
    mode: row.mode,
    topicId: text(row.topic_id),
    startedAt,
    deadlineAt: text(row.deadline_at),
    submittedAt: text(row.submitted_at),
    score: whole(row.score),
  };
}

/** One `questions` row with its four options, or null when the shape is off. */
export function readResultQuestionRow(raw: unknown): ResultQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const id = text(row.id);
  const number = whole(row.number);
  const stem = text(row.stem);
  const options = readOptions(row.options);
  if (!id || number === null || !stem || !options) return null;

  return { id, number, stem, options };
}

/**
 * A `ResultSource` over Supabase REST.
 *
 * EVERY READ FAILS SOFT, to an empty list or a null, exactly as the attempts
 * client does: a result page that cannot reach Supabase shows "nothing to
 * show" and not a stack trace. The one that matters is `readKeys`: the key
 * lock answers with a 403 (PostgREST's mapping of `insufficient_privilege`),
 * and that is a STATE, not a crash, so it comes back as an empty map and the
 * wrong list says the right answer is locked.
 *
 * No console call lives in this file and no error carries a response body: a
 * Postgres message quotes policy and constraint names.
 */
export function createSupabaseResultSource(
  options: SupabaseResultSourceOptions,
): ResultSource {
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function headers(): Record<string, string> {
    const found = env();
    return {
      apikey: found?.anonKey ?? '',
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /** Any failure is an empty list, never a crash: the page still renders. */
  async function rows(table: string, query: string): Promise<unknown[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(`${found.url}${table}?${query}`, {
      method: 'GET',
      headers: headers(),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body : [];
  }

  return {
    async readAttempt(attemptId: string) {
      if (!UUID_RE.test(attemptId)) return null;

      const found = await rows(
        ATTEMPTS,
        `select=${ATTEMPT_COLUMNS}&id=eq.${encodeURIComponent(attemptId)}&limit=1`,
      );
      return readResultAttemptRow(found[0]);
    },

    async readQuestions(attempt: ResultAttempt) {
      // Exactly one parent is set (`attempts_one_parent_check`), and the topic
      // narrows it when the student picked one topic instead of the full paper.
      const parent =
        attempt.paperId !== null
          ? `paper_id=eq.${encodeURIComponent(attempt.paperId)}`
          : attempt.testId !== null
            ? `test_id=eq.${encodeURIComponent(attempt.testId)}`
            : null;
      if (!parent) return [];

      const topic =
        attempt.topicId === null
          ? ''
          : `&topic_id=eq.${encodeURIComponent(attempt.topicId)}`;

      const found = await rows(
        QUESTIONS,
        `select=${QUESTION_COLUMNS}&${parent}${topic}` +
          // F-D2 caps a paper at 200 questions, so this limit is the whole of
          // one sitting and never a silent truncation (issue 81).
          `&status=eq.live&order=number.asc&limit=${MAX_QUESTIONS_PER_PAPER}`,
      );

      const out: ResultQuestion[] = [];
      for (const one of found) {
        const read = readResultQuestionRow(one);
        if (read) out.push(read);
      }
      return out;
    },

    async readAnswers(attemptId: string) {
      const out = new Map<string, AttemptAnswer>();
      if (!UUID_RE.test(attemptId)) return out;

      const found = await rows(
        ANSWERS,
        `select=${ANSWER_COLUMNS}&attempt_id=eq.${encodeURIComponent(attemptId)}` +
          `&limit=${MAX_QUESTIONS_PER_PAPER}`,
      );
      for (const one of found) {
        // The attempts client already owns the fail-closed rule for half an
        // answer. One reader, one rule.
        const read = readAnswerRow(one as Record<string, unknown>);
        if (read) out.set(read[0], read[1]);
      }
      return out;
    },

    async readKeys(questionIds: readonly string[]) {
      const out = new Map<string, number>();
      const ids = questionIds.filter((id) => UUID_RE.test(id));
      if (ids.length === 0) return out;

      const found = env();
      if (!found) return out;

      const res = await doFetch(`${found.url}${KEYS}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ question_ids: ids }),
        cache: 'no-store',
      });
      // 403 is the key lock talking (F-E5). An empty map, so the wrong list
      // still renders and simply says the right answer is not available.
      if (!res.ok) return out;

      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return out;

      for (const one of body) {
        if (!one || typeof one !== 'object') continue;
        const row = one as Record<string, unknown>;
        const id = text(row.question_id);
        const idx = whole(row.correct_idx);
        if (id && idx !== null) out.set(id, idx);
      }
      return out;
    },
  };
}
