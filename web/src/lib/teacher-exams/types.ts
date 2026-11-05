/**
 * The next-exam-date contract (issue 07-next-exam-date-teacher-shell).
 *
 * V7: each teacher keeps the next exam date per exam, so a row belongs to one
 * teacher and one exam. Nothing here is a platform-wide calendar.
 *
 * Dates are plain `YYYY-MM-DD` strings end to end, never `Date` objects. A
 * `date` column in Postgres has no time and no zone; turning it into a `Date`
 * in JavaScript would attach midnight UTC and a phone in IST would then read
 * "18 Dec" as 17 Dec. Strings in that format also sort and compare correctly
 * with `<` and `>`, so "nearest future date" needs no date arithmetic at all.
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call and no real key anywhere in the test suite (web/CLAUDE.md).
 *
 * Two kinds of client, because a key must never reach the browser:
 * - `TeacherExamsClient` runs on the server with the caller's own access
 *   token, so Postgres RLS (`teacher_exams_*`) is the real gate.
 * - `BrowserTeacherExamsClient` calls our own route handler and sees no key.
 */
import { t, type Lang, type LangMode } from '@/lib/i18n';

/** The pill is one short line on a 360 px phone, so the label stays short. */
export const MAX_EXAM_LABEL_LENGTH = 24;

/** Teacher dashboard routes. `/teacher/pending` is NOT one of them (issue 05). */
export const TEACHER_HOME_PATH = '/teacher/home';
export const TEACHER_PROFILE_PATH = '/teacher/profile';

/** One row of `teacher_exams`, as the app passes it around. */
export interface TeacherExam {
  examId: string;
  /** `YYYY-MM-DD`, or null when the exam body has not announced a date. */
  nextExamDate: string | null;
  /** Short name for the pill, e.g. "NET". Null falls back to the exam name. */
  label: string | null;
}

/**
 * Everything the portfolio pill needs, already narrowed to ONE exam: the
 * nearest future date. The exam names ride along so the pill can fall back to
 * them in the student's own language when the teacher set no short label.
 */
export interface NextExam {
  label: string | null;
  nameEn: string;
  nameHi: string;
  /** `YYYY-MM-DD`. Always a real future day: the page filtered already. */
  date: string;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a real calendar day written `YYYY-MM-DD`.
 *
 * The regex alone would pass `2026-02-30`, so the day is round-tripped through
 * `Date.UTC` as well. UTC, not local time, because this checks the calendar,
 * not a moment.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const found = ISO_DATE_RE.exec(value);
  if (!found) return false;

  const year = Number(found[1]);
  const month = Number(found[2]);
  const day = Number(found[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const made = new Date(Date.UTC(year, month - 1, day));
  return (
    made.getUTCFullYear() === year &&
    made.getUTCMonth() === month - 1 &&
    made.getUTCDate() === day
  );
}

function pad(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/**
 * Today as `YYYY-MM-DD` in the reader's OWN time zone, so an exam date is
 * never "past" an hour before midnight in India.
 */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The nearest date that has not gone past, or null.
 *
 * Today counts as future: an exam this morning has not happened for a student
 * reading the page tonight, and hiding it would be worse than showing it.
 * String compare is enough: `YYYY-MM-DD` sorts the same as the calendar.
 */
export function nearestFutureExam<T extends { nextExamDate: string | null }>(
  items: readonly T[],
  today: string,
): T | null {
  let best: T | null = null;
  for (const item of items) {
    const date = item.nextExamDate;
    if (date === null || !isIsoDate(date) || date < today) continue;
    if (best === null || date < (best.nextExamDate as string)) best = item;
  }
  return best;
}

/**
 * Short month names. A fixed table, not `Intl`: the build must give the same
 * string on every machine, and DESIGN.md keeps numbers in Latin digits in both
 * languages, which `Intl` with a Hindi locale does not promise.
 */
const MONTHS: Record<Lang, readonly string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hi: ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुला', 'अग', 'सित', 'अक्तू', 'नव', 'दिस'],
};

/** `2026-12-18` -> `18 Dec`. Day first, no leading zero, Latin digits. */
export function formatExamDate(iso: string, lang: Lang): string {
  const found = ISO_DATE_RE.exec(iso);
  if (!found) return iso;
  return `${Number(found[3])} ${MONTHS[lang][Number(found[2]) - 1]}`;
}

/**
 * The pill text: `Next exam: NET 18 Dec` (PRD section 7.1 sketch).
 *
 * Returns a list, the same shape as `labels()` in i18n: one line for `en` or
 * `hi`, English then Hindi for `both`, which the pill stacks.
 */
export function nextExamLines(next: NextExam, mode: LangMode): string[] {
  const langs: Lang[] = mode === 'both' ? ['en', 'hi'] : [mode];
  return langs.map((lang) => {
    const name = next.label ?? (lang === 'hi' ? next.nameHi : next.nameEn);
    return `${t('portfolio.nextExam', lang)}: ${name} ${formatExamDate(next.date, lang)}`;
  });
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface TeacherExamsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /**
   * One teacher's rows. Used twice: the teacher's own Profile page, and the
   * student's portfolio pill. Empty list on any failure, so a page still
   * renders.
   */
  listForTeacher(teacherId: string): Promise<TeacherExam[]>;
  /**
   * Replace the CALLER'S OWN list with exactly these rows: upsert each one,
   * then drop every other exam of theirs. The teacher id comes from the
   * session, never from a request body.
   */
  saveMine(items: readonly TeacherExam[]): Promise<void>;
}

/** Browser side: the Profile form. Calls our own route. */
export interface BrowserTeacherExamsClient {
  save(items: readonly TeacherExam[]): Promise<void>;
}
