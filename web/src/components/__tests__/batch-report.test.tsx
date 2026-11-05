/**
 * Issue 20-batch-reports: the score table on a teacher's batch page.
 *
 * The definition of done: "A teacher opens a batch and sees a score table per
 * test and per student, for their own tests only."
 *
 * "Their own tests only" is decided in Postgres by the two owner-rights views
 * in `0020_batch_reports.sql`, and `test/batch-reports.test.ts` proves it. This
 * file proves the other half: that the rows the views handed over are laid out
 * so a teacher can read one student across a row and one test down a column,
 * and that a cell nobody sat never reads as a zero.
 *
 * Nothing here fetches. A report is a read the server already did, so the
 * component takes rows and renders them: no client, no network, no key.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BatchReportTable } from '../batch-report';
import type { BatchMember } from '@/lib/batches/types';
import type { BatchReport } from '@/lib/reports/types';

const BATCH = '33333333-3333-4333-8333-333333333333';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const SET = '44444444-4444-4444-8444-444444444444';
const TEST_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TEST_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const MEMBERS: BatchMember[] = [
  { batchId: BATCH, userId: STUDENT, joinedAt: '2026-11-05T10:00:00.000Z' },
  { batchId: BATCH, userId: OTHER, joinedAt: '2026-11-05T11:00:00.000Z' },
];

const REPORT: BatchReport = {
  tests: [
    { testId: TEST_1, setId: SET, setTitle: 'Full length set 1', testTitle: 'Test 1', position: 1 },
    { testId: TEST_2, setId: SET, setTitle: 'Full length set 1', testTitle: 'Test 2', position: 2 },
  ],
  scores: [
    { userId: STUDENT, testId: TEST_1, score: 120, submittedAt: '2026-11-01T10:00:00Z' },
    { userId: STUDENT, testId: TEST_2, score: 96, submittedAt: '2026-11-02T10:00:00Z' },
    { userId: OTHER, testId: TEST_1, score: 64, submittedAt: '2026-11-01T11:00:00Z' },
  ],
};

/** One body row of the table, found by its short id, header cell first. */
function rowText(short: string): string[] {
  const rows = Array.from(document.querySelectorAll('tbody tr'));
  const row = rows.find((one) => one.querySelector('th')?.textContent === short);
  if (!row) throw new Error('no row for ' + short);
  return Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent ?? '');
}

describe('BatchReportTable', () => {
  it('shows one column per test and one row per student', () => {
    render(<BatchReportTable members={MEMBERS} report={REPORT} />);

    expect(screen.getByRole('columnheader', { name: /Test 1/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Test 2/ })).toBeInTheDocument();

    // Two students plus the header row.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('puts each student score in their own row', () => {
    render(<BatchReportTable members={MEMBERS} report={REPORT} />);

    expect(rowText('22222222')).toEqual(['22222222', '120', '96']);
    expect(rowText('66666666')).toEqual(['66666666', '64', '·']);
  });

  it('marks a test nobody sat instead of showing a zero', () => {
    render(<BatchReportTable members={MEMBERS} report={REPORT} />);

    // The one empty cell names itself for a screen reader, and the "0" that
    // would read as a real score is nowhere in the table.
    expect(screen.getByRole('cell', { name: 'Not taken' })).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows a real zero, because scoring nothing is a score', () => {
    const report: BatchReport = {
      tests: [REPORT.tests[0]],
      scores: [{ userId: STUDENT, testId: TEST_1, score: 0, submittedAt: '2026-11-01T10:00:00Z' }],
    };
    render(<BatchReportTable members={[MEMBERS[0]]} report={report} />);

    expect(rowText('22222222')).toEqual(['22222222', '0']);
  });

  it('carries the whole user id in the row title, because v1 has no names', () => {
    render(<BatchReportTable members={MEMBERS} report={REPORT} />);

    const header = screen.getByRole('rowheader', { name: /22222222/ });
    expect(header).toHaveAttribute('title', STUDENT);
  });

  it('sets tabular numbers on every score cell (DESIGN.md section 4)', () => {
    const { container } = render(<BatchReportTable members={MEMBERS} report={REPORT} />);

    const cells = Array.from(container.querySelectorAll('tbody td'));
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell.className).toContain('tabular-nums');
  });

  it('does not invent a column for a score whose test is not a column', () => {
    const report: BatchReport = {
      tests: [REPORT.tests[0]],
      // A score on a test the teacher no longer lists. The views cannot
      // produce this, and the table must not grow a column for it either.
      scores: [
        ...REPORT.scores,
        { userId: STUDENT, testId: 'ghost', score: 200, submittedAt: '2026-11-03T10:00:00Z' },
      ],
    };
    render(<BatchReportTable members={MEMBERS} report={report} />);

    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.queryByText('200')).not.toBeInTheDocument();
  });

  it('says nobody has joined when the batch is empty', () => {
    render(<BatchReportTable members={[]} report={REPORT} />);

    expect(screen.getByText('Nobody has joined yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says there is nothing to score when the teacher has no tests here', () => {
    render(<BatchReportTable members={MEMBERS} report={{ tests: [], scores: [] }} />);

    expect(screen.getByText('No scores yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows both languages in both mode (DESIGN.md section 1)', () => {
    render(<BatchReportTable members={MEMBERS} report={REPORT} mode="both" />);

    expect(screen.getByText('Scores')).toBeInTheDocument();
    expect(screen.getByText('अंक')).toBeInTheDocument();
  });

  it('shows Hindi only in Hindi mode', () => {
    render(<BatchReportTable members={MEMBERS} report={REPORT} mode="hi" />);

    expect(screen.getByText('अंक')).toBeInTheDocument();
    expect(screen.queryByText('Scores')).not.toBeInTheDocument();
  });
});
