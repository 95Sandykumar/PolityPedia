/**
 * Server-side `ExamClient` over the Supabase REST API (issue 18-exam-mode).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN STUDENT'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `attempts_*` policies from 0013, `attempts_mock_needs_access` from 0017, and
 * `attempt_answers_insert_open` / `_update_open` from 0018.
 *
 * TWO THINGS THIS FILE DOES THAT THE PRACTICE CLIENT DOES NOT:
 *
 *  1. IT SETS THE DEADLINE. `deadline_at = now + duration`, computed here and
 *     stored by Postgres, so the clock is one agreed value. The browser only
 *     ever subtracts from it.
 *  2. IT NEVER SENDS A VERDICT. `is_correct` goes out as an explicit null,
 *     because the phone was never given `correct_idx` (F-E5). The marking
 *     happens in `score_attempt()`, which is the only write to
 *     `attempts.score` for a timed sitting.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a Postgres message quotes policy and constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { readAttemptRow } from '@/lib/attempts/supabase-attempts-client';
import { deadlineFor, type ExamAnswer, type ExamClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ATTEMPTS = '/rest/v1/attempts';
const ANSWERS = '/rest/v1/attempt_answers';
const SCORE = '/rest/v1/rpc/score_attempt';

/** Never `select=*`, so a column added later cannot leak by accident. */
const ATTEMPT_COLUMNS =
  'id,user_id,paper_id,test_id,mode,topic_id,deadline_at,submitted_at,score';

export interface SupabaseExamClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Injected so a test can pin the clock the deadline is built from. */
  now?: () => number;
}

export function createSupabaseExamClient(
  options: SupabaseExamClientOptions,
): ExamClient {
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);
  const now = () => (options.now ?? Date.now)();

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

    async openOrStartExam({ testId, topicId, durationMin }) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(testId)) throw new Error('test id must be a uuid');
      if (topicId !== null && !UUID_RE.test(topicId)) {
        throw new Error('topic id must be a uuid');
      }

      // RESUME FIRST, and this matters more here than in practice mode: a new
      // row would mean a new `deadline_at`, so a student who closed the tab
      // would be handed another full hour, and a student who refreshed at
      // 02:00 left would be handed back 90 minutes. The clock has to be the
      // one the sitting started with.
      const open = await rows<Record<string, unknown>>(
        ATTEMPTS,
        `select=${ATTEMPT_COLUMNS}` +
          `&test_id=eq.${encodeURIComponent(testId)}` +
          '&mode=eq.exam' +
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
          mode: 'exam',
          topic_id: topicId,
          // THE CLOCK. Worked out here and stored, so the browser subtracts
          // from a value Postgres also uses to refuse a late write.
          deadline_at: deadlineFor(durationMin, now()),
        }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Supabase exam start failed with status ' + res.status);

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? body[0] : body;
      const started = readAttemptRow(first as Record<string, unknown>);
      if (!started) throw new Error('Supabase exam start returned no row');
      return started;
    },

    async saveExamAnswer(answer: ExamAnswer) {
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
          // AN EXPLICIT NULL, not an omitted field: "answered, nobody has
          // marked it yet" is the state exam mode runs in, and sending it out
          // loud is what stops a stale verdict surviving a changed answer.
          is_correct: null,
          marked: answer.marked,
          answered_at: new Date(now()).toISOString(),
        }),
        cache: 'no-store',
      });

      // Includes the normal case of an answer that arrived after the deadline.
      // The caller turns this into one short word; the clock on screen has
      // already told the student why.
      if (!res.ok) throw new Error('Supabase exam answer failed with status ' + res.status);
    },

    async scoreAttempt(attemptId: string) {
      const { url } = required();
      if (!UUID_RE.test(attemptId)) throw new Error('attempt id must be a uuid');

      const res = await doFetch(`${url}${SCORE}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json' }),
        body: JSON.stringify({ attempt_id: attemptId }),
        cache: 'no-store',
      });

      if (!res.ok) {
        // Never swallowed into a zero: a student must not be shown a score of
        // 0 for a paper the server never managed to mark.
        throw new Error('Supabase exam submit failed with status ' + res.status);
      }

      // The function returns a plain integer, which PostgREST sends as a bare
      // JSON number. A numeric string is accepted too, the way bigints arrive.
      const body = (await res.json()) as unknown;
      if (typeof body === 'number' && Number.isInteger(body)) return body;
      if (typeof body === 'string' && /^-?\d+$/.test(body)) return Number(body);
      return null;
    },
  };
}
