/**
 * The exams + onboarding contract (issue 04-exams-onboarding).
 *
 * Supabase sits behind these interfaces, so tests fake it: no real network
 * call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 * Two clients, for the same reason as auth:
 * - `ServerExamsClient` runs on the server and talks to the Supabase REST API
 *   with the signed-in user's access token, so Postgres RLS decides every read
 *   and every write.
 * - `BrowserExamsClient` runs in the page and posts to our own route handlers.
 */
import type { LangMode } from '@/lib/i18n';

/** Where a student who has not picked an exam yet is sent. */
export const ONBOARDING_PATH = '/onboarding';

/** One row of the exam catalogue. Marking is null when it is not known yet. */
export interface Exam {
  id: string;
  code: string;
  nameEn: string;
  nameHi: string;
  /** Marks for a right answer, e.g. 4 for CUET PG. Null = unknown. */
  marksCorrect: number | null;
  /** Marks for a wrong answer, e.g. -1 for CUET PG, 0 for UGC NET. Null = unknown. */
  marksWrong: number | null;
  durationMin: number | null;
  questionCount: number | null;
  /** True when the marking is believed but not confirmed (PRD AS5). */
  markingUnverified: boolean;
}

/** What the first sign-in screen sends. */
export interface OnboardingChoice {
  examIds: readonly string[];
  lang: LangMode;
}

/** What the app needs to know about the signed-in student on every page. */
export interface StudentState {
  /** `profiles.lang`. Follows the student to every device. */
  lang: LangMode;
  /** False for a brand new student, which is what triggers onboarding. */
  hasExams: boolean;
  /**
   * The exams this student picked at onboarding
   * (issue 67-teachers-filter-and-free-badge). The Teachers list filters on
   * them, so the ids are read, not just counted. Empty means "picked none",
   * which is the same state `hasExams: false` reports.
   */
  examIds: readonly string[];
}

/** Who is asking. The access token is what RLS checks; never log either field. */
export interface Caller {
  accessToken: string;
  userId: string;
}

export interface ServerExamsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  listExams(caller: Caller): Promise<Exam[]>;
  readStudentState(caller: Caller): Promise<StudentState>;
  saveOnboarding(caller: Caller, choice: OnboardingChoice): Promise<void>;
  saveLang(caller: Caller, lang: LangMode): Promise<void>;
}

/** Browser side. Calls our own routes; never sees a Supabase key. */
export interface BrowserExamsClient {
  saveOnboarding(choice: OnboardingChoice): Promise<void>;
  saveLang(lang: LangMode): Promise<void>;
}

/**
 * The lines to show for one exam: one name for `en`/`hi`, English then Hindi
 * for `both`. Same shape as `labels()` in i18n, but the text comes from the
 * database instead of the dictionary.
 */
export function examLabels(exam: Exam, mode: LangMode): string[] {
  if (mode === 'both') return [exam.nameEn, exam.nameHi];
  return [mode === 'hi' ? exam.nameHi : exam.nameEn];
}
