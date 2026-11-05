/**
 * The score table on a teacher's batch page (issue 20-batch-reports).
 *
 * F-B4: "Teacher sees batch scores (per test and per student) on their own
 * tests only."  design.md, Batches: "Batch page: join link + code, students,
 * sets given, score table."
 *
 * NO CLIENT, NO STATE, NO FETCH. A report is a read the server already did
 * with the teacher's own access token, so this component takes rows and lays
 * them out. There is nothing here to inject and nothing to go wrong offline.
 *
 * "THEIR OWN TESTS ONLY" IS NOT DECIDED HERE. It is decided by the two
 * owner-rights views in `0020_batch_reports.sql`, each filtered by
 * `teacher_id = auth.uid()`. This file could not widen it if it tried: the
 * props simply do not contain another teacher's test.
 *
 * ROWS ARE STUDENTS, COLUMNS ARE TESTS, in that order on purpose. A teacher
 * reads one student across a row to see who is slipping, which is the question
 * this screen exists to answer.
 *
 * NO STUDENT NAMES. v1 reads no other user's profile row
 * (`profiles_select_own`), so a row header is the first block of the user id,
 * with the whole id in its `title`. An honest short id beats a made-up name.
 *
 * SCOPE (issue 20 notes): no export, no charts.
 */
import type { BatchMember } from '@/lib/batches/types';
import {
  scoreAt,
  scoreGrid,
  shortId,
  testColumns,
  type BatchReport,
} from '@/lib/reports/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** 12 px / 16 px, the smallest size DESIGN.md allows, and only for meta. */
const META = 'text-xs font-normal text-muted-foreground';

/** What a cell nobody sat shows. A middle dot, never a 0 and never blank. */
const NOT_TAKEN = '·';

export function BatchReportTable({
  members,
  report,
  mode = DEFAULT_MODE,
}: {
  /** The batch roll. One row each, in the order they joined. */
  members: readonly BatchMember[];
  report: BatchReport;
  mode?: LangMode;
}) {
  const columns = testColumns(report.tests);
  const grid = scoreGrid(report.scores);

  return (
    <section className="flex flex-col gap-3">
      <Heading labelKey="report.title" mode={mode} />
      <p className="text-muted-foreground">{plain('report.hint', mode)}</p>

      {members.length === 0 ? (
        <p className="text-muted-foreground">{plain('batches.noStudents', mode)}</p>
      ) : columns.length === 0 ? (
        <p className="text-muted-foreground">{plain('report.none', mode)}</p>
      ) : (
        // The scroll lives INSIDE this box, so a batch with ten tests never
        // makes the page itself scroll sideways (DESIGN.md section 5).
        <div className={`${CARD} overflow-x-auto p-0`}>
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">{plain('report.caption', mode)}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="p-3 font-medium text-muted-foreground">
                  {plain('report.student', mode)}
                </th>
                {columns.map((column) => (
                  <th
                    key={column.testId}
                    scope="col"
                    className="p-3 text-right font-medium text-foreground"
                  >
                    <span className="block">{column.testTitle}</span>
                    {/* Which set the test came from: two sets can both hold a
                        "Test 1", and a column a teacher cannot place is a
                        column they cannot trust. */}
                    <span className={`block ${META}`}>{column.setTitle}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId} className="border-b border-border last:border-0">
                  <th
                    scope="row"
                    // The whole id, for a teacher who has to match it against
                    // something else. The cell shows the first block only.
                    title={member.userId}
                    className="p-3 font-mono text-xs font-normal text-muted-foreground"
                  >
                    {shortId(member.userId)}
                  </th>
                  {columns.map((column) => {
                    const score = scoreAt(grid, member.userId, column.testId);
                    const taken = score !== null;
                    return (
                      <td
                        key={column.testId}
                        // Named for a screen reader, because a middle dot on
                        // its own reads as nothing at all.
                        aria-label={taken ? undefined : plain('report.notTaken', mode)}
                        className={
                          'p-3 text-right tabular-nums ' +
                          (taken ? 'font-medium text-foreground' : 'text-muted-foreground')
                        }
                      >
                        <span aria-hidden={taken ? undefined : true}>
                          {taken ? String(score) : NOT_TAKEN}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Heading({ labelKey, mode }: { labelKey: MessageKey; mode: LangMode }) {
  return (
    <h2 className="text-base font-semibold text-foreground">
      {labels(labelKey, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-sm font-normal'}>
          {line}
        </span>
      ))}
    </h2>
  );
}
