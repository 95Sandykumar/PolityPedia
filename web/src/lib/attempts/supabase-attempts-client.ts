/**
 * Server-side `AttemptsClient` over the Supabase REST API
 * (issue 13-question-player).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN STUDENT'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `attempts_*` and `attempt_answers_*` policies in `0013_attempts.sql`.
 *
 * A1 LIVES IN ONE LINE: `on_conflict=attempt_id,question_id` plus
 * `Prefer: resolution=merge-duplicates`. That is what turns the insert into an
 * upsert, so the retry queue can send a held answer without asking whether it
 * already arrived.
 *
 * WHAT THIS CLIENT NO LONGER WRITES (issue 31-attempt-score-guard). The score,
 * the close and the deadline are the SERVER'S. `submit()` calls
 * `score_attempt()` instead of patching `submitted_at` and a score the browser
 * worked out, and the `is_correct` an answer carries is advisory: Postgres
 * recomputes it from `questions.correct_idx` on the way in, so the player can
 * go on showing right or wrong at once while a forged verdict goes nowhere.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a Postgres message quotes policy and constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isAttemptMode,
  type Attempt,
  type AttemptAnswer,
  type AttemptMode,
  type AttemptsClient,
  type AttemptSubmit,
  type AnswerUpsert,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ATTEMPTS = '/rest/v1/attempts';
const ANSWERS = '/rest/v1/attempt_answers';
/** The SERVER marks and closes a sitting (0018, tightened by 0031). */
const SCORE = '/rest/v1/rpc/score_attempt';

/** Never `select=*`, so a column added later cannot leak by accident. */
const ATTEMPT_COLUMNS =
  'id,user_id,paper_id,test_id,mode,topic_id,deadline_at,submitted_at,score';
const ANSWER_COLUMNS = 'question_id,chosen_idx,is_correct,marked';

interface AttemptRow {
  id?: unknown;
  user_id?: unknown;
  paper_id?: unknown;
  test_id?: unknown;
  mode?: unknown;
  topic_id?: unknown;
  deadline_at?: unknown;
  submitted_at?: unknown;
  score?: unknown;
}

interface AnswerRow {
  question_id?: unknown;
  chosen_idx?: unknown;
  is_correct?: unknown;
  marked?: unknown;
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

/** One `attempts` row, or null when it is not the shape we expect. */
export function readAttemptRow(raw: AttemptRow | null | undefined): Attempt | null {
  if (!raw || typeof raw !== 'object') return null;

  const id = text(raw.id);
  const userId = text(raw.user_id);
  if (!id || !userId) return null;
  if (!isAttemptMode(raw.mode)) return null;

  return {
    id,
    userId,
    paperId: text(raw.paper_id),
    testId: text(raw.test_id),
    mode: raw.mode,
    topicId: text(raw.topic_id),
    deadlineAt: text(raw.deadline_at),
    submittedAt: text(raw.submitted_at),
    score: whole(raw.score),
  };
}

/** One `attempt_answers` row as `[questionId, answer]`, or null. */
export function readAnswerRow(
  raw: AnswerRow | null | undefined,
): [string, AttemptAnswer] | null {
  if (!raw || typeof raw !== 'object') return null;

  const questionId = text(raw.question_id);
  if (!questionId) return null;

  const chosenIdx = raw.chosen_idx === null ? null : whole(raw.chosen_idx);
  const isCorrect =
    raw.is_correct === null || raw.is_correct === undefined
      ? null
      : raw.is_correct === true || raw.is_correct === 'true';

  // Fails CLOSED: half an answer is no answer, so it is read as "not answered"
  // rather than guessed at, and the student simply answers it again.
  if ((chosenIdx === null) !== (isCorrect === null)) {
    return [questionId, { chosenIdx: null, isCorrect: null, marked: raw.marked === true }];
  }

  return [
    questionId,
    { chosenIdx, isCorrect, marked: raw.marked === true || raw.marked === 'true' },
  ];
}

export interface SupabaseAttemptsClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseAttemptsClient(
  options: SupabaseAttemptsClientOptions,
): AttemptsClient {
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** Any failure is an empty list, never a crash: the page still renders. */
  async function rows<T>(table: string, query: string): Promise<T[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(`${found.url}${table}?${query}`, {
      method: 'GET',
      headers: headers({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as T[]) : [];
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async openOrStartForPaper({ paperId, mode, topicId = null }) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(paperId)) throw new Error('paper id must be a uuid');

      // Resume first. Without this, every re-open of the player (and every
      // double render in dev) would leave another empty attempt behind.
      const open = await rows<AttemptRow>(
        ATTEMPTS,
        `select=${ATTEMPT_COLUMNS}` +
          `&paper_id=eq.${encodeURIComponent(paperId)}` +
          `&mode=eq.${encodeURIComponent(mode)}` +
          '&submitted_at=is.null&order=started_at.desc&limit=1',
      );
      const resumed = readAttemptRow(open[0]);
      if (resumed) return resumed;

      const res = await doFetch(`${url}${ATTEMPTS}?select=${ATTEMPT_COLUMNS}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify({
          // The owner comes from the session, never from an argument of the
          // page. `attempts_insert_own` checks it again inside Postgres.
          user_id: options.userId,
          paper_id: paperId,
          mode,
          topic_id: topicId,
        }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Supabase attempt start failed with status ' + res.status);

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as AttemptRow) : (body as AttemptRow);
      const started = readAttemptRow(first);
      if (!started) throw new Error('Supabase attempt start returned no row');
      return started;
    },

    // Issue 17-practice-mode. Same shape as the paper read above, with one
    // extra rule: the TOPIC is part of what is resumed. A sitting of the full
    // paper holds different questions from a sitting of one topic, so
    // changing the Topic dropdown has to start a new sitting, never resume a
    // half-answered one whose answers belong to other questions.
    async openOrStartForTest({ testId, mode, topicId = null }) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(testId)) throw new Error('test id must be a uuid');
      if (topicId !== null && !UUID_RE.test(topicId)) {
        throw new Error('topic id must be a uuid');
      }

      const open = await rows<AttemptRow>(
        ATTEMPTS,
        `select=${ATTEMPT_COLUMNS}` +
          `&test_id=eq.${encodeURIComponent(testId)}` +
          `&mode=eq.${encodeURIComponent(mode)}` +
          (topicId === null
            ? '&topic_id=is.null'
            : `&topic_id=eq.${encodeURIComponent(topicId)}`) +
          '&submitted_at=is.null&order=started_at.desc&limit=1',
      );
      const resumed = readAttemptRow(open[0]);
      if (resumed) return resumed;

      const res = await doFetch(`${url}${ATTEMPTS}?select=${ATTEMPT_COLUMNS}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify({
          // The owner comes from the session, never from an argument of the
          // page. `attempts_insert_own` checks it again inside Postgres, and
          // `attempts_mock_needs_access` (0017) checks the paywall there too.
          user_id: options.userId,
          // The parent that is NOT set is sent as an explicit null, so the
          // XOR in `attempts_one_parent_check` holds whatever the defaults do.
          paper_id: null,
          test_id: testId,
          mode,
          topic_id: topicId,
        }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Supabase attempt start failed with status ' + res.status);

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as AttemptRow) : (body as AttemptRow);
      const started = readAttemptRow(first);
      if (!started) throw new Error('Supabase attempt start returned no row');
      return started;
    },

    async listAnswers(attemptId: string) {
      const out = new Map<string, AttemptAnswer>();
      if (!UUID_RE.test(attemptId)) return out;

      const raw = await rows<AnswerRow>(
        ANSWERS,
        `select=${ANSWER_COLUMNS}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
      );
      for (const one of raw) {
        const read = readAnswerRow(one);
        if (read) out.set(read[0], read[1]);
      }
      return out;
    },

    async saveAnswer(answer: AnswerUpsert) {
      const { url } = required();
      if (!UUID_RE.test(answer.attemptId)) throw new Error('attempt id must be a uuid');
      if (!UUID_RE.test(answer.questionId)) throw new Error('question id must be a uuid');

      // A1: the upsert. `merge-duplicates` turns the key clash into an update,
      // so sending the same answer twice rewrites one row instead of failing.
      const res = await doFetch(`${url}${ANSWERS}?on_conflict=attempt_id,question_id`, {
        method: 'POST',
        headers: headers({
          accept: 'application/json',
          prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({
          attempt_id: answer.attemptId,
          question_id: answer.questionId,
          chosen_idx: answer.chosenIdx,
          is_correct: answer.isCorrect,
          marked: answer.marked,
          // Rewritten on every send, so "when did they answer" is the last
          // time they chose, not the first time the queue managed to send.
          answered_at: new Date().toISOString(),
        }),
        cache: 'no-store',
      });

      if (!res.ok) throw new Error('Supabase answer save failed with status ' + res.status);
    },

    // Issue 31-attempt-score-guard. This used to be a PATCH that wrote
    // `submitted_at` and the score the BROWSER worked out. It is now the same
    // `score_attempt()` call exam mode makes, for one reason: a student could
    // send that PATCH themselves and set score 999. Postgres now refuses every
    // caller-side write to those two columns, so the only way to close a
    // sitting is the definer function, which reads `questions.correct_idx`
    // itself and marks with the exam's own scheme.
    //
    // The `score` in the body is DROPPED here rather than refused: it is the
    // number the player already has on screen, worked out by `scoreAnswers()`
    // from the same marking rules, so the two agree and nobody needs telling.
    //
    // Still safe to call twice: `score_attempt()` returns the stored score of
    // a closed sitting and marks nothing again.
    async submit({ attemptId }: AttemptSubmit) {
      const { url } = required();
      if (!UUID_RE.test(attemptId)) throw new Error('attempt id must be a uuid');

      const res = await doFetch(`${url}${SCORE}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json' }),
        body: JSON.stringify({ attempt_id: attemptId }),
        cache: 'no-store',
      });

      if (!res.ok) throw new Error('Supabase attempt submit failed with status ' + res.status);
    },
  };
}
