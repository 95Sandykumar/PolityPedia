/**
 * Teacher Home (issue 03-sign-in, moved into the dashboard shell by issue
 * 07-next-exam-date-teacher-shell, filled in by teacher-ui).
 *
 * The greeting, four counts, quick actions and the drafts that need the
 * teacher. Every number is read HERE, on the server, with the teacher's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides and
 * the browser never holds a key. The shell around it comes from
 * `(dashboard)/layout.tsx`.
 */
import { TeacherHome } from '@/components/teacher-home';
import { readStudentContext } from '@/lib/follows/student-page';
import { readTeacherHome } from '@/lib/teacher-home/read-home';
import { summarizeTeacherHome } from '@/lib/teacher-home/summary';

export default async function TeacherHomePage() {
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: nothing to read, so the screen shows its empty shape
  // (zeros, no name) instead of firing reads that cannot work (web/CLAUDE.md).
  const summary = configured
    ? await readTeacherHome(session)
    : summarizeTeacherHome({
        teacher: { name: null, status: null },
        papers: [],
        mocks: [],
        batches: [],
        notices: 0,
        videos: 0,
      });

  return <TeacherHome summary={summary} mode={mode} />;
}
