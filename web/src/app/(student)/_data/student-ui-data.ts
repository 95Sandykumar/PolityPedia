/**
 * Read-only helpers the student pages use to fill the new section headers
 * (student-ui pass, 2026-11-06). Server only.
 *
 * Nothing here is business logic. Every function CALLS an existing reader from
 * `src/lib` (the same ones the pages already use) and only counts, picks or
 * formats what comes back. Every read fails soft: a Supabase hiccup gives
 * `null` or an empty list and the page simply leaves that line out, it never
 * 500s and never shows a wrong number.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { Exam } from '@/lib/exams/types';
import { createSupabasePlansClient } from '@/lib/plans/supabase-plans-client';
import type { Plan } from '@/lib/plans/types';
import { readTeacherPosts } from '@/lib/posts/server-posts';
import { readLivePapers } from '@/lib/papers/teacher-page';
import { readMockList } from '@/lib/set-access/student-page';
import { createSupabaseTeacherExamsClient } from '@/lib/teacher-exams/supabase-teacher-exams-client';
import { readNextExam } from '@/lib/teacher-exams/teacher-page';
import { todayIso, type NextExam } from '@/lib/teacher-exams/types';
import type { PublicTeacher } from '@/lib/teachers/types';
import { readStudentVideos } from '@/lib/videos/page-data';

/** How many followed teachers Home asks for an exam date. Keeps Home to a few small reads. */
const MAX_EXAM_LOOKUPS = 5;

export interface HomeExam {
  exam: NextExam;
  teacherName: string;
  /** Whole days from today. 0 means today. */
  daysLeft: number;
}

/** Whole days between two `YYYY-MM-DD` days. Calendar math, no time zones. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/** The nearest future exam across the teachers this student follows. */
export async function readHomeExam(
  session: AuthSession | null,
  teachers: readonly PublicTeacher[],
): Promise<HomeExam | null> {
  if (!session || teachers.length === 0) return null;
  const today = todayIso();
  const found = await Promise.all(
    teachers.slice(0, MAX_EXAM_LOOKUPS).map(async (teacher) => ({
      teacher,
      exam: await readNextExam(session, teacher.userId, today).catch(() => null),
    })),
  );

  let best: { teacher: PublicTeacher; exam: NextExam } | null = null;
  for (const one of found) {
    if (!one.exam) continue;
    if (best === null || one.exam.date < best.exam.date) best = { teacher: one.teacher, exam: one.exam };
  }
  if (!best) return null;
  return {
    exam: best.exam,
    teacherName: best.teacher.displayName,
    daysLeft: Math.max(0, daysBetween(today, best.exam.date)),
  };
}

export interface PortfolioCounts {
  videos: number | null;
  papers: number | null;
  mocks: number | null;
  news: number | null;
}

/** How much is behind each of the four portfolio tiles. `null` = could not read. */
export async function readPortfolioCounts(
  session: AuthSession | null,
  teacher: PublicTeacher,
): Promise<PortfolioCounts> {
  const [videos, papers, mocks, news] = await Promise.all([
    teacher.videosVisible
      ? readStudentVideos(session, teacher.userId)
          .then((data) => data.videos.length)
          .catch(() => null)
      : Promise.resolve(null),
    readLivePapers(session, teacher.userId)
      .then((rows) => rows.length)
      .catch(() => null),
    readMockList(session, teacher.userId)
      .then((sets) => sets.reduce((sum, set) => sum + set.tests.length, 0))
      .catch(() => null),
    readTeacherPosts(session, teacher.userId)
      .then((rows) => rows.length)
      .catch(() => null),
  ]);
  return { videos, papers, mocks, news };
}

/** The exams this teacher teaches, by catalogue row (name in both languages). */
export async function readTeacherExamNames(
  session: AuthSession | null,
  teacherId: string,
  catalogue: readonly Exam[],
): Promise<Exam[]> {
  if (!session || catalogue.length === 0) return [];
  const rows = await createSupabaseTeacherExamsClient({
    accessToken: session.accessToken,
    userId: session.userId,
  })
    .listForTeacher(teacherId)
    .catch(() => []);
  const wanted = new Set(rows.map((row) => row.examId));
  return catalogue.filter((exam) => wanted.has(exam.id));
}

export interface PlanState {
  plan: Plan | null;
  /** ISO time the plan works until. */
  validUntil: string | null;
}

/** The student's best live plan, or `null` plan for the free tier. */
export async function readPlanState(session: AuthSession | null): Promise<PlanState> {
  const none: PlanState = { plan: null, validUntil: null };
  if (!session) return none;
  const client = createSupabasePlansClient({ accessToken: session.accessToken });
  if (!client.isConfigured()) return none;
  const rows = await client.list(session.userId).catch(() => []);
  const now = Date.now();
  const live = rows.filter((row) => new Date(row.validUntil).getTime() > now);
  const pro = live.find((row) => row.plan === 'pro');
  const ai = live.find((row) => row.plan === 'ai');
  const best = pro ?? ai;
  return best ? { plan: best.plan, validUntil: best.validUntil } : none;
}

/**
 * The e-mail inside the user's own access token, for the "Signed in as" line.
 *
 * It is only DISPLAYED, never trusted for anything: the token is the student's
 * own httpOnly cookie, read on the server, and no decision hangs on it. A token
 * that cannot be read just gives `null` and the line is left out.
 */
export function emailFromToken(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  const part = accessToken.split('.')[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const email = (JSON.parse(json) as { email?: unknown }).email;
    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}
