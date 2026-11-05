/**
 * Server-side `ReportsClient` over the Supabase REST API
 * (issue 20-batch-reports).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here. The two views in
 * `0020_batch_reports.sql` run with their owner's rights, and each one filters
 * itself by `teacher_id = auth.uid()`, so a caller reads their own batches and
 * their own tests and nothing else. The `batch_id=eq.` filter below says which
 * of their batches; it is not what makes the read safe.
 *
 * THERE IS NO WRITE IN THIS FILE. A report is a read. Both views are granted
 * SELECT only.
 *
 * Every read FAILS SOFT: a missing env, a refusal or a broken row gives an
 * empty report, never a throw. A teacher's batch page must still render its
 * join code and its roll when the report cannot be fetched.
 *
 * Security: tokens are secrets. No console call lives in this file, and
 * nothing here ever reads a response body on a failure (a Postgres message
 * quotes view and policy names).
 */
import { readSupabaseEnv } from '@/lib/auth/env';
import { isUuid } from '@/lib/batches/types';
import {
  EMPTY_BATCH_REPORT,
  type BatchReport,
  type BatchReportScore,
  type BatchReportTest,
  type ReportsClient,
} from './types';

const TESTS = '/rest/v1/batch_report_tests';
const SCORES = '/rest/v1/batch_report_scores';

/** Never `select=*`, so a column added later cannot leak by accident. */
const TEST_COLUMNS = 'test_id,set_id,set_title,test_title,test_position';
const SCORE_COLUMNS = 'user_id,test_id,score,submitted_at';

export interface SupabaseReportsClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface TestRaw {
  test_id?: unknown;
  set_id?: unknown;
  set_title?: unknown;
  test_title?: unknown;
  test_position?: unknown;
}

interface ScoreRaw {
  user_id?: unknown;
  test_id?: unknown;
  score?: unknown;
  submitted_at?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A whole number, or null. `Number.isInteger` keeps a "lots" out of a score. */
function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** One column, or null when any field is missing or the wrong shape. */
function readTestRow(raw: TestRaw): BatchReportTest | null {
  const testId = text(raw?.test_id);
  const setId = text(raw?.set_id);
  const setTitle = text(raw?.set_title);
  const testTitle = text(raw?.test_title);
  const position = whole(raw?.test_position);
  if (!testId || !setId || !setTitle || !testTitle || position === null) return null;
  return { testId, setId, setTitle, testTitle, position };
}

/**
 * One cell, or null.
 *
 * A score of 0 is a score, so the check is `=== null` and never falsy: a
 * student who scored nothing must not vanish out of the table.
 */
function readScoreRow(raw: ScoreRaw): BatchReportScore | null {
  const userId = text(raw?.user_id);
  const testId = text(raw?.test_id);
  const score = whole(raw?.score);
  const submittedAt = text(raw?.submitted_at);
  if (!userId || !testId || score === null || !submittedAt) return null;
  return { userId, testId, score, submittedAt };
}

export function createSupabaseReportsClient(
  options: SupabaseReportsClientOptions,
): ReportsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  /** Any failure is an empty list, never a crash: the page still renders. */
  async function rows<T>(view: string, query: string): Promise<T[]> {
    const found = env();
    if (!found) return [];

    const { anonKey } = found;
    const res = await doFetch(`${found.url}${view}?${query}`, {
      method: 'GET',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + options.accessToken,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json().catch(() => null)) as unknown;
    return Array.isArray(body) ? (body as T[]) : [];
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async readBatchReport(batchId: string) {
      // The id goes into a URL, so it is checked against the uuid shape first.
      if (!isUuid(batchId)) return { ...EMPTY_BATCH_REPORT };
      const filter = '&batch_id=eq.' + encodeURIComponent(batchId);

      // Two reads, one round trip's worth of time: the columns and the cells
      // are independent and a report of neither is still a report.
      const [testRaw, scoreRaw] = await Promise.all([
        rows<TestRaw>(TESTS, `select=${TEST_COLUMNS}${filter}`).catch(() => []),
        rows<ScoreRaw>(SCORES, `select=${SCORE_COLUMNS}${filter}`).catch(() => []),
      ]);

      const tests: BatchReportTest[] = [];
      for (const one of testRaw) {
        // A row we cannot read is DROPPED, never half-filled: a column with no
        // title is a column a teacher cannot name.
        const column = readTestRow(one);
        if (column) tests.push(column);
      }

      const scores: BatchReportScore[] = [];
      for (const one of scoreRaw) {
        const cell = readScoreRow(one);
        if (cell) scores.push(cell);
      }

      return { tests, scores };
    },
  };
}
