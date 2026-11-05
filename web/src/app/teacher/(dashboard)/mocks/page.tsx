/**
 * Teacher Mock sets: create a set and see your own list
 * (issue 15-mock-sets-authoring).
 *
 * V10 and V11: a set belongs to one teacher and one exam, and the teacher
 * picks the price between Rs 299 and Rs 399. This screen only ever shows the
 * caller's own rows, drafts included.
 *
 * All three reads run HERE, on the server, with the teacher's own access token
 * out of the httpOnly session cookie, so Postgres RLS decides and the browser
 * never holds a key. The writes go the other way, through
 * POST /api/teacher/mock-sets, for the same reason.
 *
 * The revenue share is read here as well, because the earning line next to the
 * stepper is the whole reason the stepper is worth having, and a client
 * component must not be the thing that reads `teachers.revenue_share_pct`.
 */
import { TeacherMocks } from '@/components/teacher-mocks';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMyMockSets, readMyShare } from '@/lib/mocks/teacher-page';
import { readExamCatalogue } from '@/lib/teacher-exams/teacher-page';

export default async function TeacherMockSetsPage() {
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: render the "not configured" state rather than firing
  // reads that cannot work (web/CLAUDE.md).
  const [exams, sets, sharePct] = configured
    ? await Promise.all([
        readExamCatalogue(session),
        readMyMockSets(session),
        readMyShare(session),
      ])
    : [[], [], 50];

  return (
    <TeacherMocks
      exams={exams}
      sets={sets}
      sharePct={sharePct}
      mode={mode}
      configured={configured}
    />
  );
}
