/**
 * The set-access contract (issue 16-set-access-mock-list).
 *
 * These are the rules the SCREEN needs: locked or unlocked, tick or no tick,
 * Attempt or Review, and the link the button points at. The paywall itself is
 * SQL and is proved in `test/set-access.test.ts`.
 *
 * The one that matters most here is `isValidUntilLive`: Postgres can store
 * `infinity`, `Date.parse('infinity')` is NaN, and a NaN read as "expired"
 * would lock a paying student out of a set they own.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMockRows,
  isAccessSource,
  isSetUnlocked,
  isTaken,
  isValidUntilLive,
  mockPlayerPath,
  mockReviewPath,
  MOCK_TOPIC_ALL,
  priceLabels,
  rupees,
  unlockLabels,
  type SetAccess,
} from '../types';

const TEACHER = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const OTHER_SET = '33333333-3333-4333-8333-333333333333';
const TEST_1 = '44444444-4444-4444-8444-444444444444';
const TEST_2 = '55555555-5555-4555-8555-555555555555';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');

function access(values: Partial<SetAccess> = {}): SetAccess {
  return {
    setId: SET,
    source: 'admin',
    validUntil: '2026-12-05T10:00:00.000Z',
    ...values,
  };
}

const SETS = [{ id: SET, title: 'Full length set 1', priceInr: 399 }];
const TESTS = [
  { id: TEST_2, setId: SET, title: 'Test 2', position: 2, isFreeSample: false },
  { id: TEST_1, setId: SET, title: 'Test 1', position: 1, isFreeSample: true },
];

describe('isValidUntilLive', () => {
  it('reads a future timestamp as live and a past one as expired', () => {
    expect(isValidUntilLive('2026-12-05T10:00:00.000Z', NOW)).toBe(true);
    expect(isValidUntilLive('2026-11-04T10:00:00.000Z', NOW)).toBe(false);
  });

  it('reads Postgres infinity as live, which Date.parse cannot', () => {
    expect(Number.isNaN(Date.parse('infinity'))).toBe(true);
    expect(isValidUntilLive('infinity', NOW)).toBe(true);
    expect(isValidUntilLive('-infinity', NOW)).toBe(false);
  });

  it('fails CLOSED on a date it cannot read', () => {
    expect(isValidUntilLive('whenever', NOW)).toBe(false);
    expect(isValidUntilLive('', NOW)).toBe(false);
  });
});

describe('isSetUnlocked', () => {
  it('is false with no rows at all', () => {
    expect(isSetUnlocked([], SET, NOW)).toBe(false);
  });

  it('ignores a row for a different set', () => {
    expect(isSetUnlocked([access({ setId: OTHER_SET })], SET, NOW)).toBe(false);
  });

  it('is true when ONE of several rows is still live', () => {
    const rows = [
      access({ source: 'batch', validUntil: '2026-11-01T10:00:00.000Z' }),
      access({ source: 'purchase', validUntil: 'infinity' }),
    ];
    expect(isSetUnlocked(rows, SET, NOW)).toBe(true);
  });

  it('is false when every row has expired', () => {
    const rows = [
      access({ source: 'batch', validUntil: '2026-11-01T10:00:00.000Z' }),
      access({ source: 'admin', validUntil: '2026-11-04T23:59:00.000Z' }),
    ];
    expect(isSetUnlocked(rows, SET, NOW)).toBe(false);
  });
});

describe('buildMockRows', () => {
  it('locks every test of a set with no access, free sample apart', () => {
    const [row] = buildMockRows({ sets: SETS, tests: TESTS, access: [], now: NOW });

    expect(row.unlocked).toBe(false);
    // Sorted by position, so Test 1 is first however the rows arrived.
    expect(row.tests.map((one) => one.title)).toEqual(['Test 1', 'Test 2']);
    expect(row.tests.map((one) => one.open)).toEqual([true, false]);
  });

  it('opens every test once the set is unlocked', () => {
    const [row] = buildMockRows({
      sets: SETS,
      tests: TESTS,
      access: [access()],
      now: NOW,
    });

    expect(row.unlocked).toBe(true);
    expect(row.tests.every((one) => one.open)).toBe(true);
  });

  it('closes the set again when the grant has expired', () => {
    const [row] = buildMockRows({
      sets: SETS,
      tests: TESTS,
      access: [access({ validUntil: '2026-11-01T10:00:00.000Z' })],
      now: NOW,
    });

    expect(row.unlocked).toBe(false);
    expect(row.tests.map((one) => one.open)).toEqual([true, false]);
  });

  it('carries the score through, and keeps a zero as a real sitting', () => {
    const [row] = buildMockRows({
      sets: SETS,
      tests: TESTS,
      access: [access()],
      scores: [
        { testId: TEST_1, score: 64 },
        { testId: TEST_2, score: 0 },
      ],
      now: NOW,
    });

    expect(row.tests[0].score).toBe(64);
    expect(row.tests[1].score).toBe(0);
    // A zero is Review, not Attempt: the student HAS taken it.
    expect(row.tests.map(isTaken)).toEqual([true, true]);
  });

  it('leaves a test with no sitting at null, so the row shows Attempt', () => {
    const [row] = buildMockRows({ sets: SETS, tests: TESTS, access: [], now: NOW });
    expect(row.tests.map((one) => one.score)).toEqual([null, null]);
    expect(row.tests.map(isTaken)).toEqual([false, false]);
  });

  it('drops a test whose set is not in the list', () => {
    const rows = buildMockRows({
      sets: SETS,
      tests: [
        ...TESTS,
        { id: 'x', setId: OTHER_SET, title: 'Orphan', position: 1, isFreeSample: true },
      ],
      access: [],
      now: NOW,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].tests).toHaveLength(2);
  });
});

describe('mockPlayerPath', () => {
  it('keeps the mode in the query', () => {
    expect(mockPlayerPath(TEACHER, TEST_1, { mode: 'exam' })).toBe(
      `/t/${TEACHER}/mocks/${TEST_1}/play?mode=exam`,
    );
  });

  it('leaves Full paper OUT of the query: no filter is not a filter', () => {
    expect(mockPlayerPath(TEACHER, TEST_1, { mode: 'practice', topicId: MOCK_TOPIC_ALL })).toBe(
      `/t/${TEACHER}/mocks/${TEST_1}/play?mode=practice`,
    );
  });

  it('carries a real topic', () => {
    expect(mockPlayerPath(TEACHER, TEST_1, { mode: 'practice', topicId: 'polity' })).toBe(
      `/t/${TEACHER}/mocks/${TEST_1}/play?mode=practice&topic=polity`,
    );
  });

  it('escapes both ids, so a path cannot be forged out of one', () => {
    expect(mockPlayerPath('a/b', 'c?d')).toBe('/t/a%2Fb/mocks/c%3Fd/play');
  });
});

describe('mockReviewPath', () => {
  it('points at review, not at the start route', () => {
    expect(mockReviewPath(TEACHER, TEST_1)).toBe(`/t/${TEACHER}/mocks/${TEST_1}/review`);
  });

  it('carries no mode and no topic: a review is not a new sitting', () => {
    expect(mockReviewPath(TEACHER, TEST_1)).not.toContain('?');
  });

  it('escapes both ids, so a path cannot be forged out of one', () => {
    expect(mockReviewPath('a/b', 'c?d')).toBe('/t/a%2Fb/mocks/c%3Fd/review');
  });
});

describe('money labels', () => {
  it('writes rupees the way each dictionary does', () => {
    expect(rupees(399, 'en')).toBe('Rs 399');
    expect(rupees(399, 'hi')).toBe('₹399');
  });

  it('builds one Unlock line per language', () => {
    expect(unlockLabels(399, 'en')).toEqual(['Unlock Rs 399']);
    expect(unlockLabels(399, 'hi')).toEqual(['खोलें ₹399']);
    expect(unlockLabels(399, 'both')).toEqual(['Unlock Rs 399', 'खोलें ₹399']);
  });

  it('shows the price when locked and the word Unlocked when not', () => {
    const locked = { id: SET, title: 'S', priceInr: 349, unlocked: false, tests: [] };
    expect(priceLabels(locked, 'en')).toEqual(['Rs 349']);
    expect(priceLabels({ ...locked, unlocked: true }, 'en')).toEqual(['Unlocked']);
  });
});

describe('isAccessSource', () => {
  it('knows the three sources in the CHECK and nothing else', () => {
    expect(['purchase', 'batch', 'admin'].every(isAccessSource)).toBe(true);
    expect(isAccessSource('gift')).toBe(false);
    expect(isAccessSource(undefined)).toBe(false);
  });
});
