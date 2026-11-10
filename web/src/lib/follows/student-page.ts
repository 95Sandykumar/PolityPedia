/**
 * The reads the three student pages of this slice share
 * (issue 06-portfolio-follow): the Teachers tab, Home, and `/t/<id>`.
 *
 * Server only. Every read runs HERE, on the server, with the student's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides the
 * rows and the browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT: a Supabase hiccup never 500s a tab. What it does NOT
 * do any more is lie. The two teacher-list reads come in a `*Result` flavour
 * that tells an empty read from a failed one (issue 54b-read-errors-home-teachers),
 * and the screens use that flavour so a broken read shows the shared error
 * state instead of "You follow nobody yet".
 */
import { cookies } from 'next/headers';
import { createSupabaseFollowsClient } from '@/lib/follows/supabase-follows-client';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import type { ListTeacherCardsInput, PublicTeacher, TeacherCard } from '@/lib/teachers/types';
import { readNextExam } from '@/lib/teacher-exams/teacher-page';
import type { NextExam } from '@/lib/teacher-exams/types';
import { DEFAULT_MODE, type LangMode } from '@/lib/i18n';
import { readOk, readWithProbe, type ReadResult } from '@/lib/read-result';

export interface StudentContext {
  session: AuthSession | null;
  /** False when the Supabase env vars are missing, or nobody is signed in. */
  configured: boolean;
  /** `profiles.lang`, so every label is in the student's chosen language. */
  mode: LangMode;
  /**
   * The exams this student picked at onboarding
   * (issue 67-teachers-filter-and-free-badge). Comes out of the SAME
   * `readStudentState` read the language already needed, so the Teachers list
   * costs no extra request. Empty when nobody is signed in.
   */
  examIds: readonly string[];
}

/** Session plus the saved language. The same two lines every student page needs. */
export async function readStudentContext(): Promise<StudentContext> {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  const exams = createSupabaseExamsClient();
  const configured = exams.isConfigured() && session !== null;

  let mode: LangMode = DEFAULT_MODE;
  let examIds: readonly string[] = [];
  if (configured && session) {
    const state = await exams
      .readStudentState(session)
      .catch(() => ({ lang: DEFAULT_MODE, hasExams: false, examIds: [] as readonly string[] }));
    mode = state.lang;
    examIds = state.examIds;
  }

  return { session, configured, mode, examIds };
}

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface TeacherListOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function teachersClient(
  session: AuthSession | null,
  options: TeacherListOptions = {},
  fetchImpl?: typeof fetch,
) {
  return createSupabaseTeachersClient({
    accessToken: session?.accessToken ?? '',
    ...(options.env ? { env: options.env } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function followsClient(
  session: AuthSession | null,
  options: TeacherListOptions = {},
  fetchImpl?: typeof fetch,
) {
  return createSupabaseFollowsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
    ...(options.env ? { env: options.env } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * Every approved teacher for the Teachers tab, and whether the read worked.
 *
 * The query is the same query as before: the same `listPublic` call on the same
 * client, so the same `teachers_public` VIEW and the same columns. The only new
 * thing is a probe handed to the client in place of `fetch`, which remembers a
 * non-ok status on the way past. The client still turns a 400 into `[]` inside
 * itself; the probe is what lets the reader know it happened.
 */
export async function readApprovedTeachersResult(
  session: AuthSession | null,
  options: TeacherListOptions = {},
): Promise<ReadResult<PublicTeacher[]>> {
  // Signed out is not broken: there is nothing to read, so it is an OK empty
  // read and the tab keeps its empty state.
  if (!session) return readOk<PublicTeacher[]>([]);

  return readWithProbe(
    (fetchImpl) =>
      teachersClient(session, options, fetchImpl)
        .listPublic()
        .catch(() => [] as PublicTeacher[]),
    options.fetchImpl,
  );
}

/**
 * The Teachers tab list (issue 67-teachers-filter-and-free-badge): approved
 * teachers WITH the free-sample badge, cut to the given exams or not cut at
 * all, and whether the read worked.
 *
 * ONE request for the whole list (B8). The badge and the exam ids both live on
 * the `teacher_cards` view (0050), so there is no per-teacher lookup here and
 * no second round trip for the filter.
 *
 * `input.examIds` left out is "Show all"; given, it is the student's own
 * exams. The reader fails CLOSED on an empty list of ids, so the CALLER has to
 * decide what no chosen exam means: see the Teachers page.
 */
export async function readTeacherCardsResult(
  session: AuthSession | null,
  input: ListTeacherCardsInput = {},
  options: TeacherListOptions = {},
): Promise<ReadResult<TeacherCard[]>> {
  // Signed out is not broken, the same rule as the list above: nothing to
  // read, so it is an OK empty read and the tab keeps its empty state.
  if (!session) return readOk<TeacherCard[]>([]);

  return readWithProbe(
    (fetchImpl) =>
      teachersClient(session, options, fetchImpl)
        .listCards(input)
        .catch(() => [] as TeacherCard[]),
    options.fetchImpl,
  );
}

/** Every approved teacher, for callers that have no error state yet. */
export async function readApprovedTeachers(
  session: AuthSession | null,
): Promise<PublicTeacher[]> {
  const read = await readApprovedTeachersResult(session);
  return read.ok ? read.data : [];
}

/**
 * The teachers this student follows, for the Home tab, and whether the read
 * worked.
 *
 * TWO queries sit inside ONE probe: the follow ids, then those ids through the
 * public view. Either one failing makes the whole thing a failure, because a
 * strip built from half the ids would quietly drop a teacher the student does
 * follow.
 */
export async function readFollowedTeachersResult(
  session: AuthSession | null,
  options: TeacherListOptions = {},
): Promise<ReadResult<PublicTeacher[]>> {
  if (!session) return readOk<PublicTeacher[]>([]);

  return readWithProbe(async (fetchImpl) => {
    const ids = await followsClient(session, options, fetchImpl)
      .listFollowing()
      .catch(() => [] as string[]);
    if (ids.length === 0) return [] as PublicTeacher[];

    const teachers = await teachersClient(session, options, fetchImpl)
      .listPublicByIds(ids)
      .catch(() => [] as PublicTeacher[]);

    // Keep the follow order (newest first), not the alphabetical order the view
    // came back in: the teacher the student just followed belongs at the top.
    const byId = new Map(teachers.map((teacher) => [teacher.userId, teacher]));
    const out: PublicTeacher[] = [];
    for (const id of ids) {
      const found = byId.get(id);
      if (found) out.push(found);
    }
    return out;
  }, options.fetchImpl);
}

/** The teachers this student follows, for callers with no error state yet. */
export async function readFollowedTeachers(
  session: AuthSession | null,
): Promise<PublicTeacher[]> {
  const read = await readFollowedTeachersResult(session);
  return read.ok ? read.data : [];
}

export interface PortfolioData {
  /**
   * Null when there is no approved teacher with that id. A `TeacherCard`, so
   * the Mocks tile can show the same "Free sample" badge as the list
   * (issue 67-teachers-filter-and-free-badge).
   */
  teacher: TeacherCard | null;
  following: boolean;
  /**
   * The nearest future exam date for the header pill, or null
   * (issue 07-next-exam-date-teacher-shell).
   */
  nextExam: NextExam | null;
}

/** One teacher, whether this student follows them, and their next exam date. */
export async function readPortfolio(
  session: AuthSession | null,
  teacherId: string,
): Promise<PortfolioData> {
  // `readCard`, not `readPublic`: the `teacher_cards` view repeats every
  // `teachers_public` column and adds the badge, so this is the same privacy
  // and one request, not two. The view is granted to `authenticated` only
  // (0050), which is exactly who reaches this function: the logged-out
  // `/t/<id>` page takes the `readPublicTeacher` path instead.
  const teacher = await teachersClient(session)
    .readCard(teacherId)
    .catch(() => null);
  if (!teacher) return { teacher: null, following: false, nextExam: null };

  const ids = await followsClient(session)
    .listFollowing()
    .catch(() => [] as string[]);

  const nextExam = await readNextExam(session, teacher.userId).catch(() => null);

  return { teacher, following: ids.includes(teacher.userId), nextExam };
}
