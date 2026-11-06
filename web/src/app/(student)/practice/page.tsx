/**
 * Practice tab. Student-ui pass (2026-11-06): was a "Coming soon" placeholder,
 * now a shortcut to the mock tests and past papers of the teachers the student
 * follows. Read on the server with the same reader Home uses.
 */
import { PracticeHub } from '@/components/practice-hub';
import { readFollowedTeachers, readStudentContext } from '@/lib/follows/student-page';
import type { PublicTeacher } from '@/lib/teachers/types';

export default async function PracticePage() {
  const { session, configured, mode } = await readStudentContext();
  const teachers: PublicTeacher[] = configured ? await readFollowedTeachers(session) : [];

  return <PracticeHub teachers={teachers} mode={mode} configured={configured} />;
}
