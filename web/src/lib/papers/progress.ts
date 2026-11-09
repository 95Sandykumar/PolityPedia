/**
 * The student's per-paper progress on the papers list (issues
 * 66-papers-question-count and 81-fix-papers-count-truncation): how many
 * questions a paper has, and whether the student has submitted an attempt on
 * it (the "Done" tick).
 *
 * Two requests for the WHOLE list, never one per row (design check B8):
 * - counts:   `paper_question_counts`, ONE row per paper, counted by Postgres.
 * - attempts: this student's submitted sittings on these papers.
 *
 * WHY THE COUNT IS NOT MADE HERE ANY MORE (issue 81). This file used to fetch
 * every live question row and count them in JavaScript. PostgREST caps a
 * response (1000 rows) and a paper holds up to 200 questions, so a teacher
 * with about six full papers lost rows off the end: the last papers read
 * "0 questions" and the list hid their Practice button. The database now
 * returns one row per paper, so the cap can never reach the answer.
 *
 * Server only. The caller's own access token is used, so Postgres RLS decides
 * the rows: the count view is `security_invoker`, so `questions_select_live`
 * still only counts live questions of an approved teacher, and
 * `attempts_select_own` only shows the student's own sittings.
 *
 * Fails SOFT. A count query that fails leaves the paper OUT of the map, so
 * the page treats the count as unknown and keeps the Practice link. An outage
 * must never hide practice from a student.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import type { AuthSession } from '@/lib/auth/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of the count view, or of the attempts table. */
type Row = { paper_id?: unknown; question_count?: unknown };

export interface PaperProgress {
  /** Live questions on the paper, as RLS lets this student count them. */
  questionCount: number;
  /** True when this student has at least one submitted attempt on the paper. */
  done: boolean;
}

export interface PaperProgressOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** GET a PostgREST path. Null on any failure, so the caller can tell "unknown". */
async function getRows(
  found: SupabaseEnv,
  path: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Row[] | null> {
  const res = await fetchImpl(`${found.url}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: found.anonKey,
      authorization: 'Bearer ' + accessToken,
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as Row[]) : null;
}

/**
 * A count out of JSON, or null when it is not a count.
 *
 * A JSON number is the normal case. A numeric STRING is read too, because
 * PostgREST hands some numeric types over as strings, and a count silently
 * read as zero would hide Practice on a full paper: the exact bug of issue 81.
 */
function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

/**
 * Progress for each paper id in the list. A paper missing from the map has
 * UNKNOWN progress, which the page shows as it did before this slice.
 */
export async function readPaperProgress(
  session: AuthSession | null,
  paperIds: readonly string[],
  options: PaperProgressOptions = {},
): Promise<Map<string, PaperProgress>> {
  const progress = new Map<string, PaperProgress>();
  // The ids go into a PostgREST filter string, so each is checked first.
  const ids = paperIds.filter((id) => UUID_RE.test(id));
  if (!session || ids.length === 0) return progress;

  const found = readSupabaseEnv(options.env ?? process.env);
  if (!found) return progress;

  const fetchImpl = options.fetchImpl ?? fetch;
  const inList = `in.(${ids.join(',')})`;
  const userId = encodeURIComponent(session.userId);

  const [countRows, attempts] = await Promise.all([
    getRows(
      found,
      `paper_question_counts?select=paper_id,question_count&paper_id=${inList}`,
      session.accessToken,
      fetchImpl,
    ).catch(() => null),
    getRows(
      found,
      `attempts?select=paper_id&user_id=eq.${userId}&submitted_at=not.is.null&paper_id=${inList}`,
      session.accessToken,
      fetchImpl,
    ).catch(() => null),
  ]);

  // A failed count query leaves every paper unknown (see the file note).
  if (!countRows) return progress;

  const counts = new Map<string, number>();
  for (const row of countRows) {
    const count = asCount(row.question_count);
    if (typeof row.paper_id === 'string' && count !== null) counts.set(row.paper_id, count);
  }

  const done = new Set<string>();
  for (const row of attempts ?? []) {
    if (typeof row.paper_id === 'string') done.add(row.paper_id);
  }

  // A paper with no live question has no row in the view, which is zero.
  for (const id of ids) {
    progress.set(id, { questionCount: counts.get(id) ?? 0, done: done.has(id) });
  }
  return progress;
}
