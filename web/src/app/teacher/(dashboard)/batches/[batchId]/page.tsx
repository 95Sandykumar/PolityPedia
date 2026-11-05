/**
 * One batch: its code, its students, and the sets it gets free
 * (issue 19-batches).
 *
 * V2's "Teacher can remove a student" and V3's "teacher picks which of their
 * mock sets a batch gets free" both live on this screen.
 *
 * Every read runs HERE, on the server, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides and the browser never
 * holds a key.
 *
 * A batch that is not the caller's comes back NULL, because RLS hid the row,
 * and the screen says "Batch not found". That is the same answer a batch that
 * does not exist gets, so the page never tells a teacher that somebody else's
 * batch is out there.
 *
 * The teacher's own mock sets are read with `readMyMockSets` from issue 15,
 * drafts included: a teacher queuing a draft up for a batch should not have to
 * publish it first to tick the box.
 */
import { TeacherBatchDetail } from '@/components/teacher-batch-detail';
import { readBatchPage, readOrigin } from '@/lib/batches/teacher-page';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMyMockSets } from '@/lib/mocks/teacher-page';

export default async function TeacherBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const { session, configured, mode } = await readStudentContext();

  const [page, sets, origin] = configured
    ? await Promise.all([
        readBatchPage(session, batchId),
        readMyMockSets(session),
        readOrigin(),
      ])
    : [{ batch: null, members: [], freeSetIds: [] }, [], ''];

  return (
    <TeacherBatchDetail
      batch={page.batch}
      members={page.members}
      sets={sets}
      freeSetIds={page.freeSetIds}
      origin={origin}
      mode={mode}
    />
  );
}
