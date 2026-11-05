/**
 * Teacher Profile: the next exam date per exam
 * (issue 07-next-exam-date-teacher-shell).
 *
 * V7: each teacher keeps their own date for each exam they teach, and this is
 * where they set it.
 *
 * Both reads run HERE, on the server, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides and the browser
 * never holds a key. The save goes the other way, through POST
 * /api/teacher/exams, for the same reason.
 */
import { TeacherExamsForm } from '@/components/teacher-exams-form';
import { readStudentContext } from '@/lib/follows/student-page';
import { readExamCatalogue, readMyExams } from '@/lib/teacher-exams/teacher-page';

export default async function TeacherProfilePage() {
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: render the "not configured" state rather than firing
  // reads that cannot work (web/CLAUDE.md).
  const [exams, items] = configured
    ? await Promise.all([readExamCatalogue(session), readMyExams(session)])
    : [[], []];

  return (
    <TeacherExamsForm exams={exams} items={items} mode={mode} configured={configured} />
  );
}
