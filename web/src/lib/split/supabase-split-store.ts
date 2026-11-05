/**
 * The worker's SplitStore over the Supabase REST API
 * (issue 12-pdf-split-worker).
 *
 * Plain `fetch` with the SERVICE-ROLE key, which bypasses RLS. That is correct
 * here and nowhere else: the worker is not a signed-in user, it has no access
 * token to carry, and it has to move a row that `ingest_jobs_update_own` would
 * never let it touch.
 *
 * SO THIS FILE IS LAPTOP ONLY. Nothing under `src/app/` or `src/components/`
 * imports it; the only importer is `web/jobs/pdf-split.ts`, which PM2 runs.
 * If a route handler ever needs job data it uses `IngestJobsClient` from issue
 * 11, which carries the caller's own token.
 *
 * Security: the key is a secret. The env is read lazily inside every call
 * (web/CLAUDE.md), no console call lives in this file, and every error it
 * throws carries a fixed message plus the HTTP status, never a response body.
 */
import { readJobRow, JOB_COLUMNS, type JobRow } from '@/lib/questions/rows';
import { MAX_QUESTIONS_PER_PAPER, type IngestJob } from '@/lib/questions/types';
import { readServiceEnv, type ServiceEnv } from './env';
import type { SplitFailure, SplitQuestion, SplitStore } from './types';

const JOBS = '/rest/v1/ingest_jobs';
const QUESTIONS = '/rest/v1/questions';
const CLAIM = '/rest/v1/rpc/claim_ingest_job';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupabaseSplitStoreOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseSplitStore(
  options: SupabaseSplitStoreOptions = {},
): SplitStore {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readServiceEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): ServiceEnv {
    const found = env();
    if (!found) throw new Error('the split worker is not configured');
    return found;
  }

  /** The three headers every call needs. The key goes in both, as PostgREST wants. */
  function headers(found: ServiceEnv, extra: Record<string, string> = {}) {
    return {
      apikey: found.serviceRoleKey,
      authorization: 'Bearer ' + found.serviceRoleKey,
      'content-type': 'application/json',
      accept: 'application/json',
      ...extra,
    };
  }

  /** A uuid that is about to go into a URL filter. Never a caller's string. */
  function id(value: string, what: string): string {
    if (!UUID_RE.test(value)) throw new Error(what + ' must be a uuid');
    return value;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /**
     * `claim_ingest_job()` from 0012, through PostgREST's RPC endpoint.
     *
     * The atomicity is in the SQL, not here: this is one POST that returns
     * either the claimed row or an empty array. Two workers racing therefore
     * cannot both get the same job, which is what design.md D1 ("1 job at a
     * time") needs when the Realtime push and the sweep fire together.
     */
    async claimQueuedJob(): Promise<IngestJob | null> {
      const found = required();

      const res = await doFetch(found.url + CLAIM, {
        method: 'POST',
        headers: headers(found),
        body: '{}',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('claim_ingest_job failed with status ' + res.status);

      const rows = (await res.json()) as JobRow[] | null;
      if (!Array.isArray(rows) || rows.length === 0) return null;

      // A row we cannot read is DROPPED, never guessed at. It stays `running`
      // and a human looks at it, which beats splitting a job we misread.
      return readJobRow(rows[0]);
    },

    async setAttempts(jobId: string, attempts: number) {
      const found = required();
      const res = await doFetch(
        `${found.url}${JOBS}?id=eq.${id(jobId, 'job id')}`,
        {
          method: 'PATCH',
          headers: headers(found, { prefer: 'return=minimal' }),
          body: JSON.stringify({ attempts }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('setAttempts failed with status ' + res.status);
    },

    /**
     * D4. Deletes this job's own DRAFTS, and only drafts.
     *
     * `status=eq.draft` is the safety rail: if the teacher already published
     * this paper, those rows are content a student can see, and a worker must
     * never delete content. A re-run that then clashes on a question number
     * fails the job with `write-failed`, which a human can read, instead of
     * quietly removing a live question.
     */
    async deleteDraftsForJob(jobId: string) {
      const found = required();
      const res = await doFetch(
        `${found.url}${QUESTIONS}?job_id=eq.${id(jobId, 'job id')}&status=eq.draft&select=id`,
        {
          method: 'DELETE',
          headers: headers(found, { prefer: 'return=representation' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('deleteDraftsForJob failed with status ' + res.status);

      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    },

    /**
     * One INSERT for the whole paper, so 200 questions are 200 rows in one
     * transaction: either the teacher's review screen fills in, or nothing
     * changed and the retry starts clean.
     *
     * `status` and `checked` are NOT sent. The column defaults are `draft` and
     * `false`, and leaving them out means no typo in this file can ever ask
     * for a live row (Risk 1).
     */
    async insertDrafts({
      job,
      questions,
    }: {
      job: IngestJob;
      questions: readonly SplitQuestion[];
    }) {
      if (questions.length === 0) return 0;
      if (questions.length > MAX_QUESTIONS_PER_PAPER) {
        throw new Error('a paper takes at most ' + MAX_QUESTIONS_PER_PAPER + ' questions');
      }

      const found = required();
      const rows = questions.map((question, index) => ({
        teacher_id: job.teacherId,
        paper_id: job.paperId,
        job_id: job.id,
        // 1-based, in the order the model read them off the page.
        number: index + 1,
        stem: question.stem,
        options: question.options,
        correct_idx: question.correctIdx,
        // The PDF's own explanation, as a starting point the teacher edits.
        // `questions` has no "ai explanation" column and inventing one for a
        // string the teacher will rewrite anyway is not worth a migration.
        teacher_explanation: question.explanation,
        lang: 'en',
      }));

      const res = await doFetch(found.url + QUESTIONS, {
        method: 'POST',
        headers: headers(found, { prefer: 'return=minimal' }),
        body: JSON.stringify(rows),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('insertDrafts failed with status ' + res.status);

      return rows.length;
    },

    async finishJob({ jobId, questionCount }: { jobId: string; questionCount: number }) {
      const found = required();
      const res = await doFetch(
        `${found.url}${JOBS}?id=eq.${id(jobId, 'job id')}`,
        {
          method: 'PATCH',
          headers: headers(found, { prefer: 'return=minimal' }),
          // `error` cleared as well: a job that finished has no error to show.
          body: JSON.stringify({
            status: 'done',
            question_count: questionCount,
            error: null,
          }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('finishJob failed with status ' + res.status);
    },

    /**
     * `failed` plus the reason.
     *
     * The reason is one of the five `SplitFailure` codes, never a message from
     * Claude or from Postgres: the review screen turns a code into English and
     * Hindi, and a model's own words could repeat something a hostile PDF told
     * it to say.
     */
    async failJob({ jobId, error }: { jobId: string; error: SplitFailure }) {
      const found = required();
      const res = await doFetch(
        `${found.url}${JOBS}?id=eq.${id(jobId, 'job id')}`,
        {
          method: 'PATCH',
          headers: headers(found, { prefer: 'return=minimal' }),
          body: JSON.stringify({ status: 'failed', error }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('failJob failed with status ' + res.status);
    },
  };
}

export { JOB_COLUMNS };
