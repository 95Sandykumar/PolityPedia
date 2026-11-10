/**
 * Read-only helpers the student pages use to fill the new section headers
 * (student-ui pass, 2026-11-06). Server only.
 *
 * Nothing here is business logic. Every function CALLS an existing reader from
 * `src/lib` (the same ones the pages already use) and only counts, picks or
 * formats what comes back. Every read fails soft: a Supabase hiccup gives
 * `null` or an empty list and the page simply leaves that line out, it never
 * 500s and never shows a wrong number.
 *
 * "Never shows a wrong number" became true in
 * issue 54b-read-errors-home-teachers. Before it, a broken read reached here as
 * `[]` and `.length` turned that into a confident `0` on the tile.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { Exam } from '@/lib/exams/types';
import { createSupabasePlansClient } from '@/lib/plans/supabase-plans-client';
import type { Plan } from '@/lib/plans/types';
import { readTeacherPostsResult } from '@/lib/posts/server-posts';
import { readLivePapersResult } from '@/lib/papers/student-page';
import { readMockListResult } from '@/lib/set-access/student-page';
import { createSupabaseTeacherExamsClient } from '@/lib/teacher-exams/supabase-teacher-exams-client';
import { readNextExam } from '@/lib/teacher-exams/teacher-page';
import { todayIso, type NextExam } from '@/lib/teacher-exams/types';
import type { PublicTeacher } from '@/lib/teachers/types';
import { readStudentVideosResult } from '@/lib/videos/page-data';

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

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface PortfolioCountsOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * How much is behind each of the four portfolio tiles. `null` = could not read.
 *
 * `null` versus `0` is the whole point of this function
 * (issue 54b-read-errors-home-teachers). A count is the read-error bug in
 * miniature: the query broke, the Supabase client swallowed the 400 into `[]`,
 * `.length` made that a confident `0`, and the Past papers tile told the
 * student the teacher had uploaded nothing. ALL FOUR reads now return a
 * RESULT, so a failure gives `null` and the tile shows NO number at all, which
 * is the only honest answer. A real 0 is still a real 0 and still shown.
 *
 * The videos count was the last one left on the old fail-soft shape, where a
 * broken read came back as an empty list and the tile said "0"
 * (issue 54-visible-read-errors, the close-out pass). It now reads the same
 * result flavour as the other three.
 */
export async function readPortfolioCounts(
  session: AuthSession | null,
  teacher: PublicTeacher,
  options: PortfolioCountsOptions = {},
): Promise<PortfolioCounts> {
  const [videos, papers, mocks, news] = await Promise.all([
    // No tile at all when the teacher switched videos off, which is not a
    // failed read and must not look like one.
    teacher.videosVisible
      ? readStudentVideosResult(session, teacher.userId, options).then((read) =>
          read.ok ? read.data.videos.length : null,
        )
      : Promise.resolve(null),
    readLivePapersResult(session, teacher.userId, options).then((read) =>
      read.ok ? read.data.length : null,
    ),
    readMockListResult(session, teacher.userId, options).then((read) =>
      read.ok ? read.data.reduce((sum, set) => sum + set.tests.length, 0) : null,
    ),
    readTeacherPostsResult(session, teacher.userId, options).then((read) =>
      read.ok ? read.data.length : null,
    ),
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
