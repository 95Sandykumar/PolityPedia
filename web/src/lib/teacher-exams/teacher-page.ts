/**
 * The server reads this slice needs (issue 07-next-exam-date-teacher-shell):
 * the teacher's own Profile page, and the pill on a student's portfolio.
 *
 * Server only. Every read runs HERE, on the server, with the caller's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides the
 * rows and the browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 and never a wrong date.
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import type { Exam } from '@/lib/exams/types';
import { createSupabaseTeacherExamsClient } from './supabase-teacher-exams-client';
import {
  nearestFutureExam,
  todayIso,
  type NextExam,
  type TeacherExam,
} from './types';

function examsClient(session: AuthSession | null) {
  return createSupabaseTeacherExamsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/** The exam catalogue, for the chips on the Profile page. */
export async function readExamCatalogue(session: AuthSession | null): Promise<Exam[]> {
  if (!session) return [];
  return createSupabaseExamsClient()
    .listExams(session)
    .catch(() => []);
}

/** The caller's own saved rows, so an edit starts from what is there. */
export async function readMyExams(session: AuthSession | null): Promise<TeacherExam[]> {
  if (!session) return [];
  return examsClient(session)
    .listForTeacher(session.userId)
    .catch(() => []);
}

/**
 * The pill for one teacher: the nearest date that has not gone past, with the
 * exam names attached so it can fall back to them when the teacher set no
 * short label. Null when there is nothing to show, which covers "no exams",
 * "no date announced" and "the last date was last month".
 *
 * `today` is a parameter so a test can fix the day; it defaults to the local
 * day of the machine rendering the page.
 */
export async function readNextExam(
  session: AuthSession | null,
  teacherId: string,
  today: string = todayIso(),
): Promise<NextExam | null> {
  if (!session) return null;

  const rows = await examsClient(session)
    .listForTeacher(teacherId)
    .catch(() => [] as TeacherExam[]);
  const nearest = nearestFutureExam(rows, today);
  if (!nearest || nearest.nextExamDate === null) return null;

  // Only now is the catalogue worth a round trip: no date, no pill, no read.
  const catalogue = await readExamCatalogue(session);
  const exam = catalogue.find((one) => one.id === nearest.examId);
  if (!exam) return null;

  return {
    label: nearest.label,
    nameEn: exam.nameEn,
    nameHi: exam.nameHi,
    date: nearest.nextExamDate,
  };
}
