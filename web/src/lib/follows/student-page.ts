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
 * Every read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 on the Home tab.
 */
import { cookies } from 'next/headers';
import { createSupabaseFollowsClient } from '@/lib/follows/supabase-follows-client';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import type { PublicTeacher } from '@/lib/teachers/types';
import { readNextExam } from '@/lib/teacher-exams/teacher-page';
import type { NextExam } from '@/lib/teacher-exams/types';
import { DEFAULT_MODE, type LangMode } from '@/lib/i18n';

export interface StudentContext {
  session: AuthSession | null;
  /** False when the Supabase env vars are missing, or nobody is signed in. */
  configured: boolean;
  /** `profiles.lang`, so every label is in the student's chosen language. */
  mode: LangMode;
}

/** Session plus the saved language. The same two lines every student page needs. */
export async function readStudentContext(): Promise<StudentContext> {
  const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
  const exams = createSupabaseExamsClient();
  const configured = exams.isConfigured() && session !== null;

  let mode: LangMode = DEFAULT_MODE;
  if (configured && session) {
    mode = await exams
      .readStudentState(session)
      .then((state) => state.lang)
      .catch(() => DEFAULT_MODE);
  }

  return { session, configured, mode };
}

function teachersClient(session: AuthSession | null) {
  return createSupabaseTeachersClient({ accessToken: session?.accessToken ?? '' });
}

function followsClient(session: AuthSession | null) {
  return createSupabaseFollowsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/** Every approved teacher, for the Teachers tab. Reads the view, never the table. */
export async function readApprovedTeachers(
  session: AuthSession | null,
): Promise<PublicTeacher[]> {
  return teachersClient(session)
    .listPublic()
    .catch(() => []);
}

/** The teachers this student follows, for the Home tab. */
export async function readFollowedTeachers(
  session: AuthSession | null,
): Promise<PublicTeacher[]> {
  const ids = await followsClient(session)
    .listFollowing()
    .catch(() => [] as string[]);
  if (ids.length === 0) return [];

  const teachers = await teachersClient(session)
    .listPublicByIds(ids)
    .catch(() => []);

  // Keep the follow order (newest first), not the alphabetical order the view
  // came back in: the teacher the student just followed belongs at the top.
  const byId = new Map(teachers.map((teacher) => [teacher.userId, teacher]));
  const out: PublicTeacher[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) out.push(found);
  }
  return out;
}

export interface PortfolioData {
  /** Null when there is no approved teacher with that id. */
  teacher: PublicTeacher | null;
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
  const teacher = await teachersClient(session)
    .readPublic(teacherId)
    .catch(() => null);
  if (!teacher) return { teacher: null, following: false, nextExam: null };

  const ids = await followsClient(session)
    .listFollowing()
    .catch(() => [] as string[]);

  const nextExam = await readNextExam(session, teacher.userId).catch(() => null);

  return { teacher, following: ids.includes(teacher.userId), nextExam };
}
