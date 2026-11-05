/**
 * Server-side TeacherExamsClient over the Supabase REST API
 * (issue 07-next-exam-date-teacher-shell).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything: the
 * `teacher_exams_select_public`, `_insert_own`, `_update_own` and `_delete_own`
 * policies in `0007_teacher_exams.sql`.
 *
 * `userId` is passed in from the session cookie, never from a request body,
 * because `teacher_exams.teacher_id` is the row owner.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { isIsoDate, type TeacherExam, type TeacherExamsClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE = '/rest/v1/teacher_exams';

/** Never `select=*`, so a column added later cannot leak by accident. */
const COLUMNS = 'exam_id,next_exam_date,label';

export interface SupabaseTeacherExamsClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface Row {
  exam_id?: unknown;
  next_exam_date?: unknown;
  label?: unknown;
}

export function createSupabaseTeacherExamsClient(
  options: SupabaseTeacherExamsClientOptions,
): TeacherExamsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /** Same headers on every call: the project key plus the caller's token. */
  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** An id goes into a URL, so it is checked against the UUID shape first. */
  function checkedId(value: string, what: string): string {
    if (!UUID_RE.test(value)) throw new Error(what + ' must be a uuid');
    return value;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listForTeacher(teacherId: string) {
      const found = env();
      if (!found) return [];
      if (!UUID_RE.test(teacherId)) return [];

      const res = await doFetch(
        `${found.url}${TABLE}?select=${COLUMNS}` +
          `&teacher_id=eq.${encodeURIComponent(teacherId)}` +
          '&order=next_exam_date.asc',
        {
          method: 'GET',
          headers: restHeaders({ accept: 'application/json' }),
          cache: 'no-store',
        },
      );
      // Any failure is an empty list, never a crash: the portfolio still
      // renders, just with no pill.
      if (!res.ok) return [];

      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];

      const out: TeacherExam[] = [];
      for (const raw of body as Row[]) {
        if (typeof raw?.exam_id !== 'string' || raw.exam_id.length === 0) continue;
        out.push({
          examId: raw.exam_id,
          // Supabase sends a `date` column as `YYYY-MM-DD`, which is the shape
          // the whole app uses. Anything else is read as "no date".
          nextExamDate: isIsoDate(raw.next_exam_date) ? raw.next_exam_date : null,
          label:
            typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : null,
        });
      }
      return out;
    },

    async saveMine(items: readonly TeacherExam[]) {
      const teacherId = checkedId(options.userId, 'user id');
      const { url } = required();
      const examIds = items.map((item) => checkedId(item.examId, 'exam id'));

      // Upsert first, then delete the rest. In that order a save can never
      // leave the teacher with no exams if the second call fails.
      if (items.length > 0) {
        const res = await doFetch(url + TABLE, {
          method: 'POST',
          // merge-duplicates turns "edit an existing date" into the same one
          // call as "add a new exam", so the form has one code path.
          headers: restHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify(
            items.map((item) => ({
              teacher_id: teacherId,
              exam_id: item.examId,
              next_exam_date: item.nextExamDate,
              label: item.label,
            })),
          ),
          cache: 'no-store',
        });
        // The status only: the body quotes the Postgres policy by name.
        if (!res.ok) throw new Error('Supabase exam date save failed with status ' + res.status);
      }

      // `teacher_id` is in the filter as well as the policy. Belt and braces:
      // a delete can then never reach past the caller's own rows.
      const keep =
        examIds.length === 0
          ? ''
          : `&exam_id=not.in.(${examIds.map((id) => encodeURIComponent(id)).join(',')})`;

      const res = await doFetch(
        `${url}${TABLE}?teacher_id=eq.${encodeURIComponent(teacherId)}${keep}`,
        {
          method: 'DELETE',
          headers: restHeaders({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) throw new Error('Supabase exam date drop failed with status ' + res.status);
    },
  };
}
