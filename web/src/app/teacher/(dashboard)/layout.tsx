/**
 * Teacher dashboard layout (issue 07-next-exam-date-teacher-shell).
 *
 * A route GROUP, `(dashboard)`, so the URLs stay `/teacher/<slot>` while
 * `/teacher/pending` stays OUTSIDE the shell. A teacher who is not approved
 * yet has no dashboard to navigate, so showing them the 5 slots would be five
 * links the middleware bounces straight back (issue 05).
 *
 * The language comes from `profiles.lang`, the same read every student page
 * does, so a teacher sees their own chosen language here too (DESIGN.md D6).
 * A failed read falls back to English rather than breaking the page.
 */
import { TeacherShell } from '@/components/teacher-shell';
import { readStudentContext } from '@/lib/follows/student-page';

export default async function TeacherDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { mode } = await readStudentContext();
  return <TeacherShell mode={mode}>{children}</TeacherShell>;
}
