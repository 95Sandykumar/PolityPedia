/**
 * Server-side exams/onboarding client over the Supabase REST API
 * (issue 04-exams-onboarding).
 *
 * Plain `fetch`, so there is no SDK to ship and `fetch` can be injected in
 * tests. Env is read lazily inside every call, so importing this file can
 * never break a build that has no environment variables (web/CLAUDE.md).
 *
 * Every call goes out with the signed-in user's access token, so Postgres RLS
 * is the gate: the catalogue is readable, `student_exams` and `profiles` are
 * limited to the caller's own rows. The anon key is only the `apikey` header.
 *
 * Security: no console call lives in this file, and the errors it throws carry
 * a fixed message plus the HTTP status, never a response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { DEFAULT_MODE, isLangMode, type LangMode } from '@/lib/i18n';
import type {
  Caller,
  Exam,
  OnboardingChoice,
  ServerExamsClient,
  StudentState,
} from './types';

const EXAM_COLUMNS =
  'id,code,name_en,name_hi,marks_correct,marks_wrong,duration_min,question_count,marking_unverified';

interface ExamRow {
  id?: unknown;
  code?: unknown;
  name_en?: unknown;
  name_hi?: unknown;
  marks_correct?: unknown;
  marks_wrong?: unknown;
  duration_min?: unknown;
  question_count?: unknown;
  marking_unverified?: unknown;
}

export interface SupabaseExamsClientOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseExamsClient(
  options: SupabaseExamsClientOptions = {},
): ServerExamsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  async function rest(caller: Caller, path: string, init: RequestInit = {}): Promise<Response> {
    const { url, anonKey } = required();
    const res = await doFetch(url + '/rest/v1' + path, {
      ...init,
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + caller.accessToken,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Supabase data call failed with status ' + res.status);
    return res;
  }

  async function rows<T>(caller: Caller, path: string): Promise<T[]> {
    const res = await rest(caller, path, { method: 'GET' });
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as T[]) : [];
  }

  async function patchLang(caller: Caller, lang: LangMode): Promise<void> {
    await rest(caller, '/profiles?id=eq.' + encodeURIComponent(caller.userId), {
      method: 'PATCH',
      body: JSON.stringify({ lang }),
    });
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listExams(caller) {
      const found = await rows<ExamRow>(caller, `/exams?select=${EXAM_COLUMNS}&order=code.asc`);
      return found.map(toExam);
    },

    async readStudentState(caller): Promise<StudentState> {
      // Two small reads instead of one join: each table has its own RLS policy,
      // and a missing profile row must not hide the exam answer.
      const profiles = await rows<{ lang?: unknown }>(caller, '/profiles?select=lang&limit=1');
      // Every id, not `limit=1`: the Teachers list filters on them
      // (issue 67-teachers-filter-and-free-badge). A student picks a handful
      // of exams at most, and the order makes the request cacheable.
      const picked = await rows<{ exam_id?: unknown }>(
        caller,
        '/student_exams?select=exam_id&order=exam_id.asc',
      );
      const lang = profiles[0]?.lang;
      // A row with no usable id is dropped rather than passed on as `''`: an
      // empty string in the filter would be rejected downstream anyway, and a
      // silent bad id is harder to see than a shorter list.
      const examIds = picked
        .map((row) => row.exam_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      return {
        lang: isLangMode(lang) ? lang : DEFAULT_MODE,
        hasExams: examIds.length > 0,
        examIds,
      };
    },

    async saveOnboarding(caller, choice: OnboardingChoice) {
      // Replace, not append: running onboarding twice leaves the same rows.
      await rest(caller, '/student_exams?user_id=eq.' + encodeURIComponent(caller.userId), {
        method: 'DELETE',
      });

      if (choice.examIds.length > 0) {
        // `user_id` is sent on every row because the insert policy checks
        // `auth.uid() = user_id`, so a row for anybody else is rejected.
        await rest(caller, '/student_exams', {
          method: 'POST',
          body: JSON.stringify(
            choice.examIds.map((examId) => ({ user_id: caller.userId, exam_id: examId })),
          ),
        });
      }

      await patchLang(caller, choice.lang);
    },

    saveLang(caller, lang) {
      return patchLang(caller, lang);
    },
  };
}

/** PostgREST sends `numeric` as a string, so marks come back as text. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toExam(row: ExamRow): Exam {
  return {
    id: toText(row.id),
    code: toText(row.code),
    nameEn: toText(row.name_en),
    nameHi: toText(row.name_hi),
    marksCorrect: toNumber(row.marks_correct),
    marksWrong: toNumber(row.marks_wrong),
    durationMin: toNumber(row.duration_min),
    questionCount: toNumber(row.question_count),
    markingUnverified: row.marking_unverified === true,
  };
}
