/**
 * The batch report contract (issue 20-batch-reports).
 *
 * F-B4: "Teacher sees batch scores (per test and per student) on their own
 * tests only." design.md, Batches: "Batch page: join link + code, students,
 * sets given, score table."
 *
 * NOTHING IN THIS FILE IS PERMISSION. The gate is `0020_batch_reports.sql`:
 * two owner-rights views, `batch_report_tests` and `batch_report_scores`, each
 * filtered by `teacher_id = auth.uid()` and each joined through
 * `mock_sets.teacher_id`, so "their own tests only" is a fact in Postgres. A
 * teacher who edits this JSON still reads zero rows about somebody else's
 * batch, because Postgres decides.
 *
 * The `attempts` policies are untouched by that migration, so a teacher still
 * cannot select a single attempt row. They read the report, nothing else.
 *
 * Supabase sits behind `ReportsClient` at the bottom, so tests fake it: no
 * real network call and no real key anywhere in the suite (web/CLAUDE.md).
 *
 * NOT HERE (issue 20 scope guard): no export, no charts.
 */

/** One column of the report: a test of one of the teacher's own sets. */
export interface BatchReportTest {
  testId: string;
  setId: string;
  /** The set the test sits in, so the header can group by set. */
  setTitle: string;
  testTitle: string;
  /** `mock_tests.position`, 1 to 100. The order inside one set. */
  position: number;
}

/**
 * One cell: what one student scored on one test.
 *
 * Marks after negative marking, not a count of right answers
 * (`attempts.score`). The newest submitted sitting, picked by the view.
 */
export interface BatchReportScore {
  userId: string;
  testId: string;
  score: number;
  /** ISO timestamp of the sitting this score came from. */
  submittedAt: string;
}

/** One batch's whole report: the columns and the cells. */
export interface BatchReport {
  tests: BatchReportTest[];
  scores: BatchReportScore[];
}

/** What a page renders when there is nothing, or when a read failed soft. */
export const EMPTY_BATCH_REPORT: BatchReport = { tests: [], scores: [] };

/**
 * The columns, in the order the header shows them: by set, then by the test's
 * own position in that set, then by id.
 *
 * The id breaks the tie so two renders of the same data can never swap two
 * columns under a teacher reading across a row. A copy is sorted, never the
 * caller's array, because the caller's array is React state.
 */
export function testColumns(tests: readonly BatchReportTest[]): BatchReportTest[] {
  return [...tests].sort(
    (one, two) =>
      one.setTitle.localeCompare(two.setTitle) ||
      one.position - two.position ||
      one.testId.localeCompare(two.testId),
  );
}

/**
 * The key of one cell.
 *
 * A NUL byte joins the two ids. Neither a uuid nor a Postgres text id can
 * contain one, so `("a", "bc")` and `("ab", "c")` cannot collide the way they
 * would under a plain `a + b`.
 */
function cellKey(userId: string, testId: string): string {
  return userId + '\u0000' + testId;
}

/** The cells, indexed for a table that reads them once per student per test. */
export function scoreGrid(
  scores: readonly BatchReportScore[],
): Map<string, BatchReportScore> {
  const grid = new Map<string, BatchReportScore>();
  for (const one of scores) grid.set(cellKey(one.userId, one.testId), one);
  return grid;
}

/**
 * The marks in one cell, or null when that student has not sat that test.
 *
 * Null, never 0: a student who sat a test and scored nothing is a different
 * fact from a student who never sat it, and a teacher reading the table has to
 * be able to tell them apart.
 */
export function scoreAt(
  grid: ReadonlyMap<string, BatchReportScore>,
  userId: string,
  testId: string,
): number | null {
  return grid.get(cellKey(userId, testId))?.score ?? null;
}

/**
 * A user id, shortened to its first block for a row header.
 *
 * v1 reads no other user's profile row (`profiles_select_own`), so a report
 * row is an id and not a name. The whole id would be wider than every score
 * column put together on a 360 px phone, so the row shows the first block and
 * carries the full id in its `title`. An honest short id beats a made-up name.
 */
export function shortId(userId: string): string {
  return userId.split('-')[0] ?? userId;
}

/**
 * Server side. Carries the caller's own access token, so the views' own
 * `teacher_id = auth.uid()` filter decides every row.
 */
export interface ReportsClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /**
   * One batch's report.
   *
   * An empty report is what a stranger gets AND what a teacher gets for
   * somebody else's batch, because the views hid every row. The screen shows
   * the same empty table for both, so it never tells anybody that a batch
   * exists but is not theirs.
   */
  readBatchReport(batchId: string): Promise<BatchReport>;
}
