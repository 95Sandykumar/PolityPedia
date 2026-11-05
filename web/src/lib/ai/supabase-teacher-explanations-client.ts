/**
 * Server-side teacher-explanations client over the Supabase REST API
 * (issue 24-revision-teacher-edit).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build that has no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: the client carries the SIGNED-IN TEACHER'S OWN access token.
 * `ai_explanations_update_owner` reads `auth.uid()` from that token, so who
 * may correct what is decided by Postgres. There is no service-role key here,
 * so a bug in a route handler cannot reach another teacher's explanation.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry only a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  sortTeacherExplanations,
  type EditExplanationInput,
  type TeacherExplanation,
  type TeacherExplanationsClient,
} from './teacher-edit';
import type { ExplanationBody } from './types';

const TABLE = '/rest/v1/ai_explanations';

/**
 * The embed is on the FK `ai_explanations.question_id -> questions.id`, so
 * `questions` is the relation name. The read uses `!inner` and filters on it,
 * which is a second lock on top of the policy: even a loosened policy could
 * not put another teacher's row in this list.
 */
const LIST_SELECT = 'question_id,lang,body,edited_by_teacher,questions!inner(stem,number)';
/** The write does not filter on the embed, so the plain form is enough. */
const WRITE_SELECT = 'question_id,lang,body,edited_by_teacher,questions(stem,number)';

export interface SupabaseTeacherExplanationsClientOptions {
  /** The teacher's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The teacher's own user id, from the same cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface StoredRow {
  question_id?: unknown;
  lang?: unknown;
  body?: unknown;
  edited_by_teacher?: unknown;
  questions?: unknown;
}

/** A stored body is only usable when it has renderable sections. */
function readBody(value: unknown): ExplanationBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sections)) return null;

  const sections = raw.sections
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .filter((s) => typeof s.body === 'string' && s.body.trim().length > 0)
    .map((s) => ({
      heading: typeof s.heading === 'string' ? s.heading : '',
      body: String(s.body),
    }));
  if (sections.length === 0) return null;

  return {
    exam: typeof raw.exam === 'string' ? raw.exam : '',
    topic: typeof raw.topic === 'string' ? raw.topic : '',
    question: typeof raw.question === 'string' ? raw.question : '',
    sections,
    remember: typeof raw.remember === 'string' ? raw.remember : '',
  };
}

/** `questions(stem,number)` arrives as an object or a one-item array. */
function readQuestion(value: unknown): { stem: string; number: number | null } {
  const question = Array.isArray(value) ? value[0] : value;
  if (typeof question !== 'object' || question === null) return { stem: '', number: null };
  const raw = question as Record<string, unknown>;
  return {
    stem: typeof raw.stem === 'string' ? raw.stem : '',
    number: typeof raw.number === 'number' ? raw.number : null,
  };
}

/**
 * One row, or null when it is not drawable. Dropping it beats rendering an
 * explanation with no text in it, which a teacher would "correct" by saving
 * the blank straight back over the AI's work.
 */
function readRow(value: unknown): TeacherExplanation | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as StoredRow;

  if (typeof row.question_id !== 'string') return null;
  if (row.lang !== 'en' && row.lang !== 'hi') return null;

  const body = readBody(row.body);
  if (!body) return null;

  const { stem, number } = readQuestion(row.questions);

  return {
    questionId: row.question_id,
    lang: row.lang,
    stem,
    number,
    body,
    editedByTeacher: row.edited_by_teacher === true,
  };
}

export function createSupabaseTeacherExplanationsClient(
  options: SupabaseTeacherExplanationsClientOptions,
): TeacherExplanationsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /** Same headers on every call: the project key plus the teacher's token. */
  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /**
     * Only `ready` rows. A `generating` or `failed` one has no text to
     * correct, and 0024 pins an edited row to `ready` anyway, so offering one
     * would be offering a form that cannot be saved.
     */
    async listMine(): Promise<TeacherExplanation[]> {
      const found = env();
      if (!found) return [];

      const res = await doFetch(
        `${found.url}${TABLE}?select=${encodeURIComponent(LIST_SELECT)}` +
          `&questions.teacher_id=eq.${encodeURIComponent(options.userId)}` +
          `&status=eq.ready`,
        { method: 'GET', headers: restHeaders({ accept: 'application/json' }), cache: 'no-store' },
      );
      // Fails SOFT: a Supabase hiccup gives an empty list and a page that
      // still renders, never a 500 on the teacher's dashboard.
      if (!res.ok) return [];

      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows)) return [];

      return sortTeacherExplanations(
        rows.map(readRow).filter((row): row is TeacherExplanation => row !== null),
      );
    },

    async edit(input: EditExplanationInput): Promise<TeacherExplanation | null> {
      const { url } = required();

      const res = await doFetch(
        `${url}${TABLE}?select=${encodeURIComponent(WRITE_SELECT)}` +
          `&question_id=eq.${encodeURIComponent(input.questionId)}&lang=eq.${input.lang}`,
        {
          method: 'PATCH',
          headers: restHeaders({ prefer: 'return=representation' }),
          // TWO fields. Everything else a teacher might send is pinned by the
          // `ai_explanations_teacher_edit` trigger, so putting it in the
          // payload would only hide that.
          body: JSON.stringify({ body: input.body, edited_by_teacher: true }),
          cache: 'no-store',
        },
      );
      // The status only. The response body may quote a policy name.
      if (!res.ok) throw new Error('Supabase edit failed with status ' + res.status);

      const rows = (await res.json()) as unknown;
      // An empty array means the policy matched nothing. That is a refusal,
      // not a success, and the route turns it into 404.
      if (!Array.isArray(rows) || rows.length === 0) return null;

      return readRow(rows[0]);
    },
  };
}
