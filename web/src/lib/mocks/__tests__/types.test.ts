/**
 * The mock sets contract (issue 15-mock-sets-authoring).
 *
 * The number the issue names is the one this file pins: a Rs 399 set at a 50%
 * share earns the teacher ABOUT Rs 165. Everything else here is the pricing
 * band (V11) and the stepper that keeps a thumb inside it.
 */
import { describe, expect, it } from 'vitest';
import {
  canBeFreeSample,
  clampPrice,
  GATEWAY_FEE_PCT,
  GST_PCT,
  MAX_PRICE_INR,
  MIN_PRICE_INR,
  mockPublishBlock,
  mockSetPath,
  nextTestPosition,
  PRICE_STEP_INR,
  readSetDraft,
  readTestDraft,
  sortTests,
  stepPrice,
  teacherEarningEstimate,
  type MockTest,
} from '../types';

const EXAM = 'a4000001-0000-4000-8000-000000000001';
const SET = '11111111-1111-4111-8111-111111111111';

function test(over: Partial<MockTest> = {}): MockTest {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    setId: SET,
    title: 'Test 1',
    position: 1,
    durationMin: 60,
    isFreeSample: false,
    ...over,
  };
}

describe('the pricing band (V11)', () => {
  it('is Rs 299 to Rs 399 in steps of Rs 10', () => {
    expect(MIN_PRICE_INR).toBe(299);
    expect(MAX_PRICE_INR).toBe(399);
    expect(PRICE_STEP_INR).toBe(10);
  });

  it('carries GST inside the price and about 2% for the gateway (AS6)', () => {
    expect(GST_PCT).toBe(18);
    expect(GATEWAY_FEE_PCT).toBe(2);
  });

  it('clamps anything outside the band to the nearest end', () => {
    expect(clampPrice(298)).toBe(299);
    expect(clampPrice(400)).toBe(399);
    expect(clampPrice(349)).toBe(349);
  });

  it('falls back to the CHEAPEST set for a number that is not a price', () => {
    // Fails closed. A price that is not a finite number is a bug, and a bug
    // must never charge a student the most expensive price in the band.
    expect(clampPrice(Number.NaN)).toBe(299);
    expect(clampPrice(Number.POSITIVE_INFINITY)).toBe(299);
    // Paise are not a price here, so a fraction is cut, never rounded up.
    expect(clampPrice(349.7)).toBe(349);
  });
});

describe('stepPrice', () => {
  it('moves Rs 10 at a time', () => {
    expect(stepPrice(299, 1)).toBe(309);
    expect(stepPrice(309, -1)).toBe(299);
    expect(stepPrice(349, 1)).toBe(359);
  });

  it('never walks out of the band', () => {
    expect(stepPrice(399, 1)).toBe(399);
    expect(stepPrice(299, -1)).toBe(299);
    // 395 + 10 would be 405, so the last step up is short.
    expect(stepPrice(395, 1)).toBe(399);
    // 305 - 10 would be 295, so the last step down is short.
    expect(stepPrice(305, -1)).toBe(299);
  });
});

describe('teacherEarningEstimate (X3: share on net)', () => {
  it('gives Rs 165 for a Rs 399 set at a 50% share', () => {
    expect(teacherEarningEstimate(399, 50)).toBe(165);
  });

  it('gives Rs 124 for the cheapest set at a 50% share', () => {
    expect(teacherEarningEstimate(299, 50)).toBe(124);
  });

  it('rounds DOWN, so the line never promises more than the sale pays', () => {
    // 399 / 1.18 x 0.98 = 331.37..., which is the whole net amount.
    expect(teacherEarningEstimate(399, 100)).toBe(331);
    expect(teacherEarningEstimate(349, 60)).toBe(173);
  });

  it('is zero for a zero share, and never negative', () => {
    expect(teacherEarningEstimate(399, 0)).toBe(0);
    expect(teacherEarningEstimate(399, -10)).toBe(0);
  });

  it('refuses to guess from a price or a share that is not a number', () => {
    expect(teacherEarningEstimate(Number.NaN, 50)).toBe(0);
    expect(teacherEarningEstimate(399, Number.NaN)).toBe(0);
  });
});

describe('canBeFreeSample (V11: Test 1 only)', () => {
  it('is true for position 1 and false for every other position', () => {
    expect(canBeFreeSample(1)).toBe(true);
    expect(canBeFreeSample(2)).toBe(false);
    expect(canBeFreeSample(0)).toBe(false);
  });
});

describe('nextTestPosition', () => {
  it('starts at 1 for an empty set', () => {
    expect(nextTestPosition([])).toBe(1);
  });

  it('is one past the HIGHEST position, not the count', () => {
    expect(nextTestPosition([test({ position: 1 }), test({ position: 4 })])).toBe(5);
  });
});

describe('mockPublishBlock', () => {
  it('is blocked on an empty set: there would be nothing to buy', () => {
    expect(mockPublishBlock({ tests: [], questions: [] })).toBe('no-tests');
    // Reported FIRST, even when a question is unchecked too.
    expect(mockPublishBlock({ tests: [], questions: [{ checked: false }] })).toBe(
      'no-tests',
    );
  });

  it('is blocked while ONE question is unchecked (V9)', () => {
    expect(
      mockPublishBlock({
        tests: [test()],
        questions: [{ checked: true }, { checked: false }],
      }),
    ).toBe('unchecked');
  });

  it('is open for a set with tests and every question checked', () => {
    expect(
      mockPublishBlock({ tests: [test()], questions: [{ checked: true }] }),
    ).toBeNull();
  });

  it('is open for a set with tests and no questions yet', () => {
    // The shell today, the questions tomorrow. "Every question is checked" is
    // trivially true when there are none, and the database agrees.
    expect(mockPublishBlock({ tests: [test()], questions: [] })).toBeNull();
  });
});

describe('sortTests', () => {
  it('puts the tests in position order and leaves the input alone', () => {
    const input = [test({ position: 3 }), test({ position: 1 }), test({ position: 2 })];
    expect(sortTests(input).map((one) => one.position)).toEqual([1, 2, 3]);
    expect(input.map((one) => one.position)).toEqual([3, 1, 2]);
  });
});

describe('readSetDraft', () => {
  const good = { examId: EXAM, title: '  Full length set 1  ', priceInr: 349 };

  it('reads a good body and trims the title', () => {
    expect(readSetDraft(good)).toEqual({
      examId: EXAM,
      title: 'Full length set 1',
      priceInr: 349,
    });
  });

  it('refuses a price outside the band, rather than quietly clamping it', () => {
    expect(readSetDraft({ ...good, priceInr: 298 })).toBeNull();
    expect(readSetDraft({ ...good, priceInr: 400 })).toBeNull();
    expect(readSetDraft({ ...good, priceInr: 349.5 })).toBeNull();
  });

  it('defaults a missing price to the floor', () => {
    expect(readSetDraft({ examId: EXAM, title: 'No price' })?.priceInr).toBe(299);
  });

  it('refuses an exam id that is not a uuid, and a blank title', () => {
    expect(readSetDraft({ ...good, examId: 'net' })).toBeNull();
    expect(readSetDraft({ ...good, title: '   ' })).toBeNull();
    expect(readSetDraft(null)).toBeNull();
  });

  it('drops a teacherId and a status, so a body can never set them', () => {
    const read = readSetDraft({ ...good, teacherId: SET, status: 'live' });
    expect(read).not.toHaveProperty('teacherId');
    expect(read).not.toHaveProperty('status');
  });
});

describe('readTestDraft', () => {
  const good = { title: ' Test 1 ', position: 1, durationMin: 120, isFreeSample: true };

  it('reads a good body and trims the title', () => {
    expect(readTestDraft(good)).toEqual({
      title: 'Test 1',
      position: 1,
      durationMin: 120,
      isFreeSample: true,
    });
  });

  it('refuses a free sample anywhere but position 1 (V11)', () => {
    expect(readTestDraft({ ...good, position: 2 })).toBeNull();
    // Position 2 is fine when it is not a free sample.
    expect(readTestDraft({ ...good, position: 2, isFreeSample: false })?.position).toBe(2);
  });

  it('fails CLOSED on the free flag: anything but true is a paid test', () => {
    expect(readTestDraft({ ...good, isFreeSample: 'yes' })?.isFreeSample).toBe(false);
    expect(readTestDraft({ ...good, isFreeSample: undefined })?.isFreeSample).toBe(false);
  });

  it('refuses a position or a duration outside the range', () => {
    expect(readTestDraft({ ...good, position: 0 })).toBeNull();
    expect(readTestDraft({ ...good, position: 101 })).toBeNull();
    expect(readTestDraft({ ...good, durationMin: 0 })).toBeNull();
    expect(readTestDraft({ ...good, durationMin: 361 })).toBeNull();
  });

  it('defaults a missing duration to 60 minutes', () => {
    expect(readTestDraft({ title: 'Test 2', position: 2 })?.durationMin).toBe(60);
  });
});

describe('mockSetPath', () => {
  it('points at the teacher page and escapes the id', () => {
    expect(mockSetPath(SET)).toBe(`/teacher/mocks/${SET}`);
    expect(mockSetPath('a b')).toBe('/teacher/mocks/a%20b');
  });
});
