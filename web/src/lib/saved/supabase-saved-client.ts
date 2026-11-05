/**
 * Server-side `SavedClient` over the Supabase REST API (issue 14-saved-list).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN STUDENT'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `saved_questions_*_own` policies in `0014_saved.sql`.
 *
 * THE IDEMPOTENT SAVE IS ONE LINE: `on_conflict=user_id,question_id,tag` plus
 * `Prefer: resolution=merge-duplicates`. That is what turns the insert into an
 * upsert, so a wrong answer saved on every tap stays ONE row.
 *
 * THE LIST READS THE QUESTION WITH IT. One request, with `questions(...)`
 * embedded, so the tab does not make a second round trip per row. The embed is
 * filtered by `questions_select_live`, so a draft question comes back as null
 * and the row is dropped here: the Saved tab can never show a draft.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a Postgres message quotes policy and constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { isSavedTag, type SavedClient, type SavedItem, type SavedTag } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/saved_questions';

/**
 * Never `select=*`, so a column added later cannot leak by accident. The
 * embedded `questions` row is what lets one request draw the whole tab.
 */
const COLUMNS =
  'question_id,tag,created_at,questions(teacher_id,paper_id,number,stem)';

interface QuestionPart {
  teacher_id?: unknown;
  paper_id?: unknown;
  number?: unknown;
  stem?: unknown;
}

interface SavedRow {
  question_id?: unknown;
  tag?: unknown;
  created_at?: unknown;
  /** PostgREST returns an embedded one-to-one as an object, or null. */
  questions?: QuestionPart | QuestionPart[] | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function whole(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // PostgREST can hand a number back as text, so a numeric string is taken too.
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * One `saved_questions` row with its question, or null.
 *
 * Fails CLOSED. A row with no readable question, an unknown tag or a missing
 * stem is DROPPED: a Saved row the student cannot open would be worse than one
 * that is not there.
 */
export function readSavedRow(raw: SavedRow | null | undefined): SavedItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const questionId = text(raw.question_id);
  if (!questionId || !isSavedTag(raw.tag)) return null;

  const part = Array.isArray(raw.questions) ? raw.questions[0] : raw.questions;
  if (!part || typeof part !== 'object') return null;

  const teacherId = text(part.teacher_id);
  const stem = text(part.stem);
  const number = whole(part.number);
  if (!teacherId || !stem || number === null) return null;

  return {
    questionId,
    tag: raw.tag,
    createdAt: text(raw.created_at),
    teacherId,
    paperId: text(part.paper_id),
    number,
    stem,
  };
}

export interface SupabaseSavedClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseSavedClient(
  options: SupabaseSavedClientOptions,
): SavedClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
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

  /**
   * Both ids go into a URL, so both are checked against the UUID shape first.
   * That is what stops a crafted id from steering the request at another path.
   */
  function checked(questionId: string, tag: SavedTag): void {
    if (!UUID_RE.test(questionId)) throw new Error('question id must be a uuid');
    if (!UUID_RE.test(options.userId)) throw new Error('user id must be a uuid');
    if (!isSavedTag(tag)) throw new Error('tag must be wrong or marked');
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async list() {
      const found = env();
      if (!found) return [];

      const res = await doFetch(`${found.url}${TABLE}?select=${COLUMNS}&order=created_at.desc`, {
        method: 'GET',
        headers: headers({ accept: 'application/json' }),
        cache: 'no-store',
      });
      // Any failure is an empty list, never a crash: the tab still renders.
      if (!res.ok) return [];

      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];

      const out: SavedItem[] = [];
      for (const raw of body as SavedRow[]) {
        const read = readSavedRow(raw);
        if (read) out.push(read);
      }
      return out;
    },

    async save(questionId: string, tag: SavedTag) {
      checked(questionId, tag);
      const { url } = required();

      // The idempotent write: `merge-duplicates` turns the key clash into a
      // no-op update, so the same save twice is one row.
      const res = await doFetch(`${url}${TABLE}?on_conflict=user_id,question_id,tag`, {
        method: 'POST',
        headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
          // The owner comes from the session, never from an argument.
          // `saved_questions_insert_own` checks it again inside Postgres.
          user_id: options.userId,
          question_id: questionId,
          tag,
        }),
        cache: 'no-store',
      });

      // The status only: the body quotes the Postgres policy by name.
      if (!res.ok) throw new Error('Supabase save failed with status ' + res.status);
    },

    async remove(questionId: string, tag: SavedTag) {
      checked(questionId, tag);
      const { url } = required();

      // `user_id` is in the filter as well as in the policy. Belt and braces:
      // a delete can then never reach past the caller's own row. `tag` is in
      // it too, so removing Wrong leaves Marked on the same question alone.
      const res = await doFetch(
        `${url}${TABLE}?user_id=eq.${encodeURIComponent(options.userId)}` +
          `&question_id=eq.${encodeURIComponent(questionId)}` +
          `&tag=eq.${encodeURIComponent(tag)}`,
        {
          method: 'DELETE',
          headers: headers({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );

      if (!res.ok) throw new Error('Supabase remove failed with status ' + res.status);
    },
  };
}
