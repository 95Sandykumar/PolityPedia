/**
 * Teacher Papers: upload a past paper and see your own list
 * (issue 10-papers-upload-browse).
 *
 * V8: past papers are per teacher, so this screen only ever shows the
 * caller's own rows, drafts included.
 *
 * Both reads run HERE, on the server, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides and the browser
 * never holds a key. The upload goes the other way, through POST
 * /api/teacher/papers, for the same reason.
 *
 * The AI split and the publish button are issues 11 and 12.
 */
import { TeacherPapersForm } from '@/components/teacher-papers-form';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMyPapers } from '@/lib/papers/teacher-page';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';

export default async function TeacherPapersPage() {
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: render the "not configured" state rather than firing
  // reads that cannot work (web/CLAUDE.md).
  const [exams, papers] = configured
    ? await Promise.all([readExamCatalogue(session), readMyPapers(session)])
    : [[], []];

  return (
    <TeacherPapersForm
      exams={exams}
      papers={papers}
      mode={mode}
      configured={configured}
    />
  );
}
