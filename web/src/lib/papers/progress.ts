/**
 * The student's per-paper progress on the papers list (issue
 * 66-papers-question-count): how many questions a paper has, and whether the
 * student has submitted an attempt on it (the "Done" tick).
 *
 * Two requests for the WHOLE list, never one per row (design check B8):
 * - questions: the live rows of these papers, counted here per paper.
 * - attempts: this student's submitted sittings on these papers.
 *
 * Server only. The caller's own access token is used, so Postgres RLS decides
 * the rows: `questions_select_live` only shows live questions of an approved
 * teacher, and `attempts_select_own` only shows the student's own sittings.
 *
 * Fails SOFT. A question query that fails leaves the paper OUT of the map, so
 * the page treats the count as unknown and keeps the Practice link. An outage
 * must never hide practice from a student.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import type { AuthSession } from '@/lib/auth/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaperProgress {
  /** Live questions on the paper, as RLS lets this student read them. */
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
): Promise<Array<{ paper_id?: unknown }> | null> {
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
  return Array.isArray(body) ? (body as Array<{ paper_id?: unknown }>) : null;
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

  const [questions, attempts] = await Promise.all([
    getRows(
      found,
      `questions?select=paper_id&status=eq.live&paper_id=${inList}`,
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

  // A failed question query leaves every paper unknown (see the file note).
  if (!questions) return progress;

  const counts = new Map<string, number>();
  for (const row of questions) {
    if (typeof row.paper_id === 'string') {
      counts.set(row.paper_id, (counts.get(row.paper_id) ?? 0) + 1);
    }
  }

  const done = new Set<string>();
  for (const row of attempts ?? []) {
    if (typeof row.paper_id === 'string') done.add(row.paper_id);
  }

  for (const id of ids) {
    progress.set(id, { questionCount: counts.get(id) ?? 0, done: done.has(id) });
  }
  return progress;
}
