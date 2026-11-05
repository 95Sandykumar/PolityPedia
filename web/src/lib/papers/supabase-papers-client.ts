/**
 * Server-side PapersClient over the Supabase REST API
 * (issue 10-papers-upload-browse).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `papers_select_live`, `_insert_own`, `_update_own` and `_delete_own`
 * policies in `0010_papers.sql`.
 *
 * `userId` is passed in from the session cookie, never from a request body,
 * because `papers.teacher_id` is the row owner.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { isPaperStatus, type NewPaper, type Paper, type PapersClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/papers';

/** Never `select=*`, so a column added later cannot leak by accident. */
const COLUMNS =
  'id,teacher_id,exam_id,year,month,label,pdf_questions_path,pdf_solutions_path,status';

/** Newest paper first, which is the order a student wants them in. */
const ORDER = '&order=exam_id.asc,year.desc,month.desc,label.asc';

export interface SupabasePapersClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface Row {
  id?: unknown;
  teacher_id?: unknown;
  exam_id?: unknown;
  year?: unknown;
  month?: unknown;
  label?: unknown;
  pdf_questions_path?: unknown;
  pdf_solutions_path?: unknown;
  status?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One row, or null when any field is missing or the wrong shape. */
function readRow(raw: Row): Paper | null {
  const id = text(raw?.id);
  const teacherId = text(raw?.teacher_id);
  const examId = text(raw?.exam_id);
  const label = text(raw?.label);
  if (!id || !teacherId || !examId || !label) return null;
  if (typeof raw.year !== 'number' || !Number.isInteger(raw.year)) return null;
  // A status we do not know is not trusted: it could mean "live" one day.
  if (!isPaperStatus(raw.status)) return null;

  const month =
    typeof raw.month === 'number' && Number.isInteger(raw.month) ? raw.month : null;

  return {
    id,
    teacherId,
    examId,
    year: raw.year,
    month,
    label,
    questionsPath: text(raw.pdf_questions_path),
    solutionsPath: text(raw.pdf_solutions_path),
    status: raw.status,
  };
}

export function createSupabasePapersClient(
  options: SupabasePapersClientOptions,
): PapersClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** Any failure is an empty list, never a crash: the page still renders. */
  async function list(query: string): Promise<Paper[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(`${found.url}${TABLE}?select=${COLUMNS}${query}${ORDER}`, {
      method: 'GET',
      headers: restHeaders({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];

    const out: Paper[] = [];
    for (const raw of body as Row[]) {
      const paper = readRow(raw);
      if (paper) out.push(paper);
    }
    return out;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listMine() {
      if (!UUID_RE.test(options.userId)) return [];
      return list(`&teacher_id=eq.${encodeURIComponent(options.userId)}`);
    },

    async listLiveForTeacher(teacherId: string) {
      if (!UUID_RE.test(teacherId)) return [];
      // `status=eq.live` as well as the policy. Belt and braces: a teacher
      // reading their OWN portfolio page would otherwise see their drafts
      // there, which is not what a student sees.
      return list(`&teacher_id=eq.${encodeURIComponent(teacherId)}&status=eq.live`);
    },

    async readOne(paperId: string) {
      // The id goes into a URL, so it is checked against the UUID shape first.
      if (!UUID_RE.test(paperId)) return null;
      const rows = await list(`&id=eq.${encodeURIComponent(paperId)}&limit=1`);
      return rows[0] ?? null;
    },

    async create(paper: NewPaper) {
      const { url } = required();
      if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');

      const res = await doFetch(`${url}${TABLE}?select=${COLUMNS}`, {
        method: 'POST',
        headers: restHeaders({
          accept: 'application/json',
          prefer: 'return=representation',
        }),
        body: JSON.stringify({
          // The owner comes from the session, never from the caller's body.
          teacher_id: options.userId,
          exam_id: paper.examId,
          year: paper.year,
          month: paper.month,
          label: paper.label,
          pdf_questions_path: paper.questionsPath,
          pdf_solutions_path: paper.solutionsPath,
          // Always a draft. Publish is issue 11 (PRD F-D3).
          status: 'draft',
        }),
        cache: 'no-store',
      });

      if (res.status === 409) {
        // The unique constraint. Named, so the route can answer 409 without
        // reading a Postgres message that quotes the constraint.
        throw Object.assign(new Error('paper already exists'), { name: 'PaperConflict' });
      }
      if (!res.ok) {
        throw new Error('Supabase paper save failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? (body[0] as Row) : (body as Row);
      const stored = readRow(first ?? {});
      if (!stored) throw new Error('Supabase paper save returned no row');
      return stored;
    },
  };
}
