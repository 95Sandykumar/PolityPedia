/**
 * Teacher Batches: the list, with a student count and a join link per row
 * (issue 19-batches).
 *
 * V2: a teacher makes many batches and a student joins by link or code. This
 * screen only ever shows the caller's own rows, because
 * `batches_select_own_or_member` decides the read and the client filters on
 * `teacher_id` as well.
 *
 * Both reads run HERE, on the server, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides and the browser
 * never holds a key. The writes go the other way, through
 * POST /api/teacher/batches, for the same reason.
 */
import { TeacherBatches } from '@/components/teacher-batches';
import { readMyBatches, readOrigin } from '@/lib/batches/teacher-page';
import { readStudentContext } from '@/lib/follows/student-page';

export default async function TeacherBatchesPage() {
  const { session, configured, mode } = await readStudentContext();

  // No keys, no session: render the "not configured" state rather than firing
  // reads that cannot work (web/CLAUDE.md).
  const [batches, origin] = configured
    ? await Promise.all([readMyBatches(session), readOrigin()])
    : [[], ''];

  return (
    <TeacherBatches
      batches={batches}
      origin={origin}
      mode={mode}
      configured={configured}
    />
  );
}
