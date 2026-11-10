/**
 * The review of ONE SUBMITTED sitting (issue 57a-review-reader).
 *
 * `readAttemptResult()` (56a) answers "how did it go": a score, the counts and
 * the questions that went wrong, one line each. `readAttemptReview()` answers
 * the question a student asks next: "show me the whole paper again". Every
 * question of the sitting, in paper order, with the full stem, all four
 * options, the one they picked, the right one and the teacher's prose beside
 * it. Ticket 57 draws it; nothing here knows what a pixel is.
 *
 * FOUR RULES, AND THREE OF THEM BELONG TO POSTGRES:
 *
 *  1. IT IS A READ, AND THAT IS THE POINT OF THE SLICE. Opening a review must
 *     not create a sitting, resume one, or close one, in practice mode or in
 *     exam mode. `ReviewSource` has no write method, so there is nothing here
 *     to get wrong later: the type is the guard.
 *  2. ONLY A SUBMITTED SITTING HAS A REVIEW (0030). The port is asked for the
 *     NEWEST SUBMITTED one, and the reader stops before the key read if what
 *     came back is somehow open. A student mid-retake reviews the sitting
 *     behind it, not the one they are in.
 *  3. ANOTHER STUDENT'S SITTING IS NOT HIDDEN HERE. `attempts_select_own`
 *     (0013) hides it. The port returns null for a row RLS did not hand over,
 *     and this file treats null as "nothing to review", not as an error,
 *     because the two are indistinguishable from outside and should be.
 *  4. THE KEY AND THE PROSE ARE ALL OR NOTHING. `question_keys()` (0030) and
 *     `question_explanations()` (0037) both RAISE while the caller has an open
 *     exam sitting of the same test (F-E5), which is a real state: a student
 *     can open the exam in a second tab and then review an older sitting. The
 *     question is still listed, with `right: null` and `explanation: null`, and
 *     the screen says the key is locked. Nothing is invented.
 *
 * THE DIFFERENCE FROM THE RESULT READ, in one line: the result asks for the
 * key of the WRONG questions only, because that is all it shows. The review
 * shows every question, so it asks for every id of the sitting. Same minimum
 * disclosure rule, wider screen.
 *
 * Supabase sits behind `ReviewSource` (web/CLAUDE.md), so the test drives the
 * reader against real Postgres through PGlite and the three database rules are
 * proven instead of imitated.
 */
import { MAX_QUESTIONS_PER_PAPER } from '@/lib/questions/types';
import { readSupabaseEnv } from '@/lib/auth/env';
import {
  closedOnTheClock,
  createSupabaseResultSource,
  optionAt,
  readResultAttemptRow,
  secondsBetween,
  type SupabaseResultSourceOptions,
} from './result';
import {
  optionLetter,
  type AttemptReview,
  type ResultOption,
  type ReviewQuestion,
  type ReviewSource,
  type ReviewTarget,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A target with exactly one parent and valid ids, or null.
 *
 * `attempts_one_parent_check` (0013) says a sitting has a paper OR a test and
 * never both, so a request with neither or two is a bug upstream. It reads as
 * null RIGHT HERE, before any read happens, so a malformed ask costs no
 * database call and leaks nothing about what exists.
 */
export function readReviewTarget(target: ReviewTarget): ReviewTarget | null {
  const paperId = target.paperId ?? null;
  const testId = target.testId ?? null;
  const topicId = target.topicId ?? null;

  if ((paperId === null) === (testId === null)) return null;
  if (paperId !== null && !UUID_RE.test(paperId)) return null;
  if (testId !== null && !UUID_RE.test(testId)) return null;
  if (topicId !== null && !UUID_RE.test(topicId)) return null;

  return { paperId, testId, topicId, mode: target.mode ?? null };
}

/** All four options, in order, with the letter that was on the button. */
function allOptions(question: { options: readonly string[] }): ResultOption[] {
  return question.options.map((text, idx) => ({ idx, letter: optionLetter(idx), text }));
}

/**
 * The review of the newest submitted sitting of this paper or test, or null.
 *
 * Null covers every "there is nothing to review" at once: no sitting, every
 * sitting still open, or a sitting that is not this student's (RLS hid the
 * row). A caller cannot tell those apart, and must not: one of them is a
 * privacy answer, and a different reply for each would be the leak.
 */
export async function readAttemptReview(
  source: ReviewSource,
  target: ReviewTarget,
): Promise<AttemptReview | null> {
  const asked = readReviewTarget(target);
  if (!asked) return null;

  const attempt = await source.readNewestSubmitted(asked);
  if (!attempt) return null;

  // Rule 2, said twice on purpose. The port asked for a submitted sitting;
  // this is the reader refusing to trust that it got one, BEFORE it asks for
  // a key or a line of prose.
  const submittedAt = attempt.submittedAt;
  if (!submittedAt) return null;

  const questions = [...(await source.readQuestions(attempt))].sort(
    (a, b) => a.number - b.number,
  );
  const answers = await source.readAnswers(attempt.id);

  // Every question of the sitting, because every one is shown. An empty paper
  // asks for nothing at all, the same as a result with nothing wrong.
  const ids = questions.map((one) => one.id);
  const [keys, explanations] =
    ids.length > 0
      ? await Promise.all([source.readKeys(ids), source.readExplanations(ids)])
      : [new Map<string, number>(), new Map<string, string>()];

  let right = 0;
  let wrong = 0;
  let skipped = 0;
  const out: ReviewQuestion[] = [];

  // The QUESTIONS lead, not the answers: a question nobody touched has no
  // answer row at all, and it is still a question in the sitting. An answer
  // whose question is not in this sitting (another topic) is ignored for the
  // same reason.
  for (const question of questions) {
    const answer = answers.get(question.id);
    // The STORED verdict (0031), never worked out again from the key. It is
    // what the server decided at the moment of answering, so it survives the
    // key lock and a later moderation fix alike.
    const isCorrect = answer?.isCorrect ?? null;
    if (isCorrect === true) right += 1;
    else if (isCorrect === false) wrong += 1;
    else skipped += 1;

    const found = keys.get(question.id);
    out.push({
      questionId: question.id,
      number: question.number,
      // The WHOLE stem. `shortStem` belongs to the one-line result list.
      stem: question.stem,
      options: allOptions(question),
      chosen: optionAt(question.options, answer?.chosenIdx ?? null),
      right: optionAt(question.options, found === undefined ? null : found),
      isCorrect,
      marked: answer?.marked === true,
      // Rule 4. Absent is absent: no prose written, or the prose is locked.
      // The screen says which from `right` being null on every question.
      explanation: explanations.get(question.id) ?? null,
    });
  }

  const total = questions.length;

  return {
    attemptId: attempt.id,
    mode: attempt.mode,
    // The stored number, repeated (0031). A closed sitting always has one:
    // `score_attempt()` writes `submitted_at` and `score` in one UPDATE.
    score: attempt.score ?? 0,
    total,
    percent: total > 0 ? Math.round((right / total) * 100) : 0,
    right,
    wrong,
    skipped,
    timeTakenSec: secondsBetween(attempt.startedAt, submittedAt),
    autoSubmitted: closedOnTheClock(attempt.deadlineAt, submittedAt),
    questions: out,
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
//
// It is BUILT ON the result source, not beside it: the questions, the answers
// and the key come from exactly the same three calls the result page makes,
// and only the two new reads are written here.

const ATTEMPTS = '/rest/v1/attempts';
/** The one way to the teacher's prose (0037). A definer function, so an RPC. */
const EXPLANATIONS = '/rest/v1/rpc/question_explanations';

/**
 * Never `select=*`, so a column added later cannot leak by accident, and never
 * `correct_idx` or `teacher_explanation`: 0030 and 0037 revoked both from
 * `authenticated`, so asking for either would fail the whole read.
 */
const ATTEMPT_COLUMNS =
  'id,user_id,paper_id,test_id,mode,topic_id,started_at,deadline_at,submitted_at,score';

export type SupabaseReviewSourceOptions = SupabaseResultSourceOptions;

/**
 * A `ReviewSource` over Supabase REST.
 *
 * EVERY READ FAILS SOFT, to a null or an empty map, exactly as the result
 * source does: a review page that cannot reach Supabase shows "nothing to
 * review" and not a stack trace. The one that matters is `readExplanations`:
 * the lock answers with a 403 (PostgREST's mapping of
 * `insufficient_privilege`), and that is a STATE, not a crash, so it comes
 * back as an empty map and the screen says the prose is locked.
 *
 * NOTHING HERE WRITES. There is no POST, PATCH or DELETE in this file, which
 * is the whole of "read only" for the Supabase side of the slice.
 *
 * No console call lives in this file and no error carries a response body: a
 * Postgres message quotes policy and constraint names.
 */
export function createSupabaseReviewSource(
  options: SupabaseReviewSourceOptions,
): ReviewSource {
  const result = createSupabaseResultSource(options);
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

  return {
    // The three reads the result page already makes, unchanged. One reader
    // each, so a fix to the answer shape reaches both screens at once.
    readAttempt: result.readAttempt,
    readQuestions: result.readQuestions,
    readAnswers: result.readAnswers,
    readKeys: result.readKeys,

    async readNewestSubmitted(target: ReviewTarget) {
      const asked = readReviewTarget(target);
      if (!asked) return null;

      const found = env();
      if (!found) return null;

      const parent =
        asked.paperId !== null
          ? `paper_id=eq.${encodeURIComponent(asked.paperId)}`
          : `test_id=eq.${encodeURIComponent(asked.testId as string)}`;
      const topic =
        asked.topicId === null
          ? ''
          : `&topic_id=eq.${encodeURIComponent(asked.topicId)}`;
      const mode =
        asked.mode === null || asked.mode === undefined
          ? ''
          : `&mode=eq.${encodeURIComponent(asked.mode)}`;

      // `user_id` is NOT in this query, on purpose: `attempts_select_own`
      // (0013) decides whose sitting this is from the session token, and a
      // filter here would only be a second opinion with no authority.
      const res = await doFetch(
        `${found.url}${ATTEMPTS}?select=${ATTEMPT_COLUMNS}&${parent}${topic}${mode}` +
          '&submitted_at=not.is.null&order=submitted_at.desc&limit=1',
        { method: 'GET', headers: headers(), cache: 'no-store' },
      );
      if (!res.ok) return null;

      const body = (await res.json()) as unknown;
      const rows = Array.isArray(body) ? body : [];
      if (rows.length === 0) return null;

      // One row shape, one validator. `readResultAttemptRow` already knows
      // how to read an `attempts` row, so it is not written twice.
      return readResultAttemptRow(rows[0]);
    },

    async readExplanations(questionIds: readonly string[]) {
      const out = new Map<string, string>();
      const ids = questionIds.filter((id) => UUID_RE.test(id)).slice(0, MAX_QUESTIONS_PER_PAPER);
      if (ids.length === 0) return out;

      const found = env();
      if (!found) return out;

      const res = await doFetch(`${found.url}${EXPLANATIONS}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ question_ids: ids }),
        cache: 'no-store',
      });
      // 403 is the lock talking (F-E5). An empty map, so every question still
      // renders and simply says the prose is not available.
      if (!res.ok) return out;

      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return out;

      for (const one of body) {
        if (!one || typeof one !== 'object') continue;
        const row = one as Record<string, unknown>;
        const id = row.question_id;
        const prose = row.teacher_explanation;
        if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
        // A teacher who wrote nothing is not a teacher who wrote "".
        if (typeof prose !== 'string' || prose.length === 0) continue;
        out.set(id, prose);
      }
      return out;
    },
  };
}
