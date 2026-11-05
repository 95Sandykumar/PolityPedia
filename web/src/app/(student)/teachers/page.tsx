/**
 * Teachers tab (issue 06-portfolio-follow).
 *
 * Every APPROVED teacher, read on the server from the `teachers_public` VIEW
 * with the student's own access token. The view is what strips the real name
 * of an alias teacher (PRD F-A5) and what filters out teachers who are still
 * waiting for an admin.
 *
 * Tapping a row opens `/t/<id>`, that teacher's portfolio.
 */
import { TeachersList } from '@/components/teachers-list';
import { readApprovedTeachers, readStudentContext } from '@/lib/follows/student-page';
import type { PublicTeacher } from '@/lib/teachers/types';

export default async function TeachersPage() {
  const { session, configured, mode } = await readStudentContext();
  const teachers: PublicTeacher[] = configured ? await readApprovedTeachers(session) : [];

  return (
    <TeachersList
      teachers={teachers}
      titleKey="teachers.title"
      emptyKey="teachers.none"
      mode={mode}
      configured={configured}
    />
  );
}
