/**
 * Server-side `QuestionsClient` and `IngestJobsClient` over the Supabase REST
 * API (issue 11-ingest-job-review-publish).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `questions_*` and `ingest_jobs_*` policies in `0011_questions.sql`.
 *
 * V9, the rule this file must not break: a SAVE never sends a `status`. A
 * question goes live only through `publish_paper()`, which checks that every
 * question is checked and that the split has finished. The column also has
 * `questions_live_is_checked_check` behind it, so even a wrong body here could
 * not make a live unchecked question.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status or a Postgres
 * ERROR CODE, never a response body (a Postgres message quotes policy and
 * constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  JOB_COLUMNS,
  QUESTION_COLUMNS,
  readJobRow,
  readQuestionRow,
  type JobRow,
  type QuestionRow,
} from './rows';
import type {
  IngestJob,
  IngestJobsClient,
  Question,
  QuestionEdit,
  QuestionsClient,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUESTIONS = '/rest/v1/questions';
const JOBS = '/rest/v1/ingest_jobs';
const PUBLISH = '/rest/v1/rpc/publish_paper';

/**
 * The Postgres error codes `publish_paper()` raises -> the NAME the route
 * handler switches on.
 *
 * A code, not a message: the message is English prose that may be reworded,
 * and reading it would also mean reading a body that can quote constraint
 * names.
 *
 *  23514 check_violation                     -> a question is still unchecked
 *  55000 object_not_in_prerequisite_state    -> the split is still running
 *  42501 insufficient_privilege              -> somebody else's paper
 *  P0002 no_data_found                       -> no such paper (for this caller)
 */
const PUBLISH_ERRORS: Record<string, string> = {
  '23514': 'PublishUnchecked',
  '55000': 'PublishSplitting',
  '42501': 'PublishForbidden',
  P0002: 'PublishForbidden',
};

export interface SupabaseQuestionsClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** The bits both clients share: lazy env, headers, and a soft list read. */
function base(options: SupabaseQuestionsClientOptions) {
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

  return { env, doFetch, required, headers, rows };
}

export function createSupabaseQuestionsClient(
  options: SupabaseQuestionsClientOptions,
): QuestionsClient {
  const { env, doFetch, required, headers, rows } = base(options);

  return {
    isConfigured() {
      return env() !== null;
    },

    async listForPaper(paperId: string) {
      // The id goes into a URL, so it is checked against the UUID shape first.
      if (!UUID_RE.test(paperId)) return [];

      const raw = await rows<QuestionRow>(
        QUESTIONS,
        `select=${QUESTION_COLUMNS}` +
          `&paper_id=eq.${encodeURIComponent(paperId)}` +
          '&order=number.asc',
      );

      const out: Question[] = [];
      for (const one of raw) {
        // A row we cannot read is DROPPED, never half-filled: a review screen
        // showing three options would make the teacher check a broken
        // question (Risk 1).
        const question = readQuestionRow(one);
        if (question) out.push(question);
      }
      return out;
    },

    async save(edit: QuestionEdit) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(edit.paperId)) throw new Error('paper id must be a uuid');
      if (edit.id !== null && !UUID_RE.test(edit.id)) {
        throw new Error('question id must be a uuid');
      }

      // The fields a teacher may change. No `status`: V9.
      const fields = {
        number: edit.number,
        stem: edit.stem,
        options: edit.options,
        correct_idx: edit.correctIdx,
        teacher_explanation: edit.teacherExplanation,
        lang: edit.lang,
        checked: edit.checked,
      };

      const existing = edit.id;
      const target =
        existing === null
          ? `${url}${QUESTIONS}?select=${QUESTION_COLUMNS}`
          : `${url}${QUESTIONS}?id=eq.${encodeURIComponent(existing)}` +
            `&select=${QUESTION_COLUMNS}`;

      const res = await doFetch(target, {
        method: existing === null ? 'POST' : 'PATCH',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify(
          existing === null
            ? {
                // The owner comes from the session, never from the body.
                teacher_id: options.userId,
                paper_id: edit.paperId,
                ...fields,
              }
            : // On an update, neither the owner nor the parent moves: the
              // `questions_update_own` policy would refuse it anyway, and not
              // sending them means a bug here cannot try.
              fields,
        ),
        cache: 'no-store',
      });

      if (res.status === 409) {
        // `questions_paper_number_idx`. Named, so the route can answer 409
        // without reading a Postgres message that quotes the index.
        throw Object.assign(new Error('that question number is taken'), {
          name: 'QuestionConflict',
        });
      }
      if (!res.ok) {
        throw new Error('Supabase question save failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as QuestionRow) : (body as QuestionRow);
      const stored = readQuestionRow(first);
      // An empty array from a PATCH means RLS hid the row: somebody else's
      // question. Treated as a failure, so the screen never shows "saved".
      if (!stored) throw new Error('Supabase question save returned no row');
      return stored;
    },

    async publishPaper(paperId: string) {
      const { url } = required();
      if (!UUID_RE.test(paperId)) throw new Error('paper id must be a uuid');

      const res = await doFetch(`${url}${PUBLISH}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json' }),
        body: JSON.stringify({ paper_id: paperId }),
        cache: 'no-store',
      });

      if (!res.ok) {
        // Read the CODE only. The message beside it is prose and may quote a
        // constraint name, so it never leaves this function.
        let code = '';
        try {
          const body = (await res.json()) as { code?: unknown };
          if (typeof body?.code === 'string') code = body.code;
        } catch {
          // No JSON body. Falls through to the generic error below.
        }

        const name = PUBLISH_ERRORS[code];
        if (name) {
          throw Object.assign(new Error('publish refused'), { name });
        }
        throw new Error('Supabase publish failed with status ' + res.status);
      }

      // The function returns a plain integer, which PostgREST sends as a bare
      // JSON number.
      const body = (await res.json()) as unknown;
      if (typeof body === 'number' && Number.isInteger(body)) return body;
      if (typeof body === 'string' && /^\d+$/.test(body)) return Number(body);
      return 0;
    },
  };
}

export function createSupabaseIngestJobsClient(
  options: SupabaseQuestionsClientOptions,
): IngestJobsClient {
  const { env, doFetch, required, headers, rows } = base(options);

  return {
    isConfigured() {
      return env() !== null;
    },

    async createQueued({ paperId, pdfPath }) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
      if (!UUID_RE.test(paperId)) throw new Error('paper id must be a uuid');

      const res = await doFetch(`${url}${JOBS}?select=${JOB_COLUMNS}`, {
        method: 'POST',
        headers: headers({ accept: 'application/json', prefer: 'return=representation' }),
        // No `status`: the column defaults to `queued`, which is the only
        // status a job may be created with.
        body: JSON.stringify({
          teacher_id: options.userId,
          paper_id: paperId,
          pdf_path: pdfPath,
        }),
        cache: 'no-store',
      });

      if (!res.ok) {
        throw new Error('Supabase job queue failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as JobRow) : (body as JobRow);
      const stored = readJobRow(first);
      if (!stored) throw new Error('Supabase job queue returned no row');
      return stored;
    },

    async readLatestForPaper(paperId: string): Promise<IngestJob | null> {
      if (!UUID_RE.test(paperId)) return null;

      const raw = await rows<JobRow>(
        JOBS,
        `select=${JOB_COLUMNS}` +
          `&paper_id=eq.${encodeURIComponent(paperId)}` +
          '&order=created_at.desc&limit=1',
      );
      return readJobRow(raw[0]);
    },
  };
}
