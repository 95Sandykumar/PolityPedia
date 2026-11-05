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
 *
 * The score table under it (issue 20-batch-reports, F-B4) is a FOURTH read of
 * its own, against the two owner-rights views in `0020_batch_reports.sql`. It
 * runs beside the other three, and it fails soft: a report that cannot be
 * fetched leaves an empty table and a page that still shows the join code.
 */
import { BatchReportTable } from '@/components/batch-report';
import { TeacherBatchDetail } from '@/components/teacher-batch-detail';
import { readBatchPage, readOrigin } from '@/lib/batches/teacher-page';
import { readStudentContext } from '@/lib/follows/student-page';
import { readMyMockSets } from '@/lib/mocks/teacher-page';
import { readBatchReport } from '@/lib/reports/teacher-page';
import { EMPTY_BATCH_REPORT } from '@/lib/reports/types';

export default async function TeacherBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const { session, configured, mode } = await readStudentContext();

  const [page, sets, origin, report] = configured
    ? await Promise.all([
        readBatchPage(session, batchId),
        readMyMockSets(session),
        readOrigin(),
        readBatchReport(session, batchId),
      ])
    : [{ batch: null, members: [], freeSetIds: [] }, [], '', EMPTY_BATCH_REPORT];

  return (
    <div className="flex flex-col gap-6">
      <TeacherBatchDetail
        batch={page.batch}
        members={page.members}
        sets={sets}
        freeSetIds={page.freeSetIds}
        origin={origin}
        mode={mode}
      />
      {/* Only under a batch that is really the caller's. A null batch is a
          batch RLS hid, and a score table under "Batch not found" would be a
          second, louder way of saying nothing. */}
      {page.batch ? (
        <BatchReportTable members={page.members} report={report} mode={mode} />
      ) : null}
    </div>
  );
}
