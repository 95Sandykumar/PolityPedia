/**
 * The batch report contract (issue 20-batch-reports).
 *
 * Everything here is pure. The permission lives in `0020_batch_reports.sql`:
 * two owner-rights views filtered by `teacher_id = auth.uid()`. These helpers
 * only decide how the rows that came back are laid out on a screen.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_BATCH_REPORT,
  scoreAt,
  scoreGrid,
  shortId,
  testColumns,
  type BatchReportScore,
  type BatchReportTest,
} from '../types';

const STUDENT_ONE = '11111111-1111-4111-8111-111111111111';
const STUDENT_TWO = '22222222-2222-4222-8222-222222222222';
const TEST_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TEST_TWO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

function test(
  testId: string,
  setTitle: string,
  testTitle: string,
  position: number,
): BatchReportTest {
  return { testId, setId: 'set-' + setTitle, setTitle, testTitle, position };
}

function score(userId: string, testId: string, value: number): BatchReportScore {
  return { userId, testId, score: value, submittedAt: '2026-11-01T10:00:00Z' };
}

describe('EMPTY_BATCH_REPORT', () => {
  it('is the shape a page renders when there is nothing to show', () => {
    expect(EMPTY_BATCH_REPORT).toEqual({ tests: [], scores: [] });
  });
});

describe('testColumns', () => {
  it('orders by set, then by position in the set', () => {
    const ordered = testColumns([
      test(TEST_TWO, 'Set B', 'Test 1', 1),
      test(TEST_ONE, 'Set A', 'Test 2', 2),
      test('third', 'Set A', 'Test 1', 1),
    ]);
    expect(ordered.map((one) => one.testId)).toEqual(['third', TEST_ONE, TEST_TWO]);
  });

  it('breaks a tie on the id, so two renders never swap two columns', () => {
    const ordered = testColumns([
      test('bbb', 'Set A', 'Test 1', 1),
      test('aaa', 'Set A', 'Test 1', 1),
    ]);
    expect(ordered.map((one) => one.testId)).toEqual(['aaa', 'bbb']);
  });

  it('leaves the list it was given alone', () => {
    const given = [test(TEST_TWO, 'Set B', 'Test 1', 1), test(TEST_ONE, 'Set A', 'Test 1', 1)];
    testColumns(given);
    expect(given[0].testId).toBe(TEST_TWO);
  });
});

describe('scoreGrid and scoreAt', () => {
  it('finds the score of one student on one test', () => {
    const grid = scoreGrid([score(STUDENT_ONE, TEST_ONE, 120), score(STUDENT_TWO, TEST_ONE, 64)]);
    expect(scoreAt(grid, STUDENT_ONE, TEST_ONE)).toBe(120);
    expect(scoreAt(grid, STUDENT_TWO, TEST_ONE)).toBe(64);
  });

  it('is null for a cell nobody sat, which is not a zero', () => {
    const grid = scoreGrid([score(STUDENT_ONE, TEST_ONE, 120)]);
    expect(scoreAt(grid, STUDENT_ONE, TEST_TWO)).toBeNull();
    expect(scoreAt(grid, STUDENT_TWO, TEST_ONE)).toBeNull();
  });

  it('keeps a real zero apart from a cell nobody sat', () => {
    const grid = scoreGrid([score(STUDENT_ONE, TEST_ONE, 0)]);
    expect(scoreAt(grid, STUDENT_ONE, TEST_ONE)).toBe(0);
  });

  it('does not let one student id plus one test id collide with another pair', () => {
    // A key built by gluing two ids together must not be ambiguous.
    const grid = scoreGrid([score('a', 'bc', 1), score('ab', 'c', 2)]);
    expect(scoreAt(grid, 'a', 'bc')).toBe(1);
    expect(scoreAt(grid, 'ab', 'c')).toBe(2);
  });
});

describe('shortId', () => {
  it('shortens a user id to its first block, because v1 has no names', () => {
    expect(shortId(STUDENT_ONE)).toBe('11111111');
  });

  it('gives back anything too short unchanged, never a crash', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('');
  });
});
