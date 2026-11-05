/**
 * Practice mode for mock tests: the pure half (issue 17-practice-mode).
 *
 * Two facts the definition of done names, and they are both arithmetic:
 *
 *  * F-E6, MARKING PER EXAM. A score is MARKS, not a count of right answers.
 *    CUET PG is +4 and -1, so 10 right and 5 wrong is 35, not 10. UGC NET is
 *    +2 and 0. PGT and TGT marking is not known yet (PRD section 6), and an
 *    unknown scheme must not score a student at zero: it falls back to one
 *    mark a question with no negative marking, which is exactly what the
 *    player did before this slice.
 *
 *  * F-E4, the TOPIC FILTER. "Full paper" is the default and is not a topic
 *    id, so the query carries no topic at all.
 *
 * No network call and no key here: every function is pure.
 */
import { describe, expect, it } from 'vitest';
import type { AttemptAnswer } from '@/lib/attempts/types';
import {
  DEFAULT_MARKING,
  MOCK_TOPIC_ALL,
  markingOf,
  practiceHeading,
  readRequestedMode,
  readTopicFilter,
  scoreAnswers,
  totalMarks,
} from '../types';

const TOPIC = '99999999-9999-4999-8999-999999999999';

/** CUET PG, from the 0004 seed: +4 for a right answer, -1 for a wrong one. */
const CUET = { marksCorrect: 4, marksWrong: -1 };
/** UGC NET: +2, no negative marking. */
const NET = { marksCorrect: 2, marksWrong: 0 };

function answers(spec: { right?: number; wrong?: number; marked?: number }) {
  const out = new Map<string, AttemptAnswer>();
  let n = 0;
  for (let i = 0; i < (spec.right ?? 0); i += 1) {
    out.set('q' + n++, { chosenIdx: 1, isCorrect: true, marked: false });
  }
  for (let i = 0; i < (spec.wrong ?? 0); i += 1) {
    out.set('q' + n++, { chosenIdx: 0, isCorrect: false, marked: false });
  }
  for (let i = 0; i < (spec.marked ?? 0); i += 1) {
    // Marked for later and never answered: no verdict, so no marks either way.
    out.set('q' + n++, { chosenIdx: null, isCorrect: null, marked: true });
  }
  return out;
}

describe('markingOf', () => {
  it('takes the exam s own marks', () => {
    expect(markingOf(CUET)).toEqual({ marksCorrect: 4, marksWrong: -1 });
    expect(markingOf(NET)).toEqual({ marksCorrect: 2, marksWrong: 0 });
  });

  it('falls back to one mark with no negative marking when the scheme is unknown', () => {
    // PGT and TGT: both columns are null in the 0004 seed (PRD section 6).
    expect(markingOf({ marksCorrect: null, marksWrong: null })).toEqual(DEFAULT_MARKING);
    expect(markingOf(null)).toEqual(DEFAULT_MARKING);
    expect(markingOf(undefined)).toEqual(DEFAULT_MARKING);
  });

  it('keeps a known half of the scheme and defaults only the missing half', () => {
    expect(markingOf({ marksCorrect: 2, marksWrong: null })).toEqual({
      marksCorrect: 2,
      marksWrong: 0,
    });
  });

  it('refuses a marks_correct of zero, which would score every paper at zero', () => {
    expect(markingOf({ marksCorrect: 0, marksWrong: 0 })).toEqual(DEFAULT_MARKING);
  });

  it('never lets marks_wrong be positive: a wrong answer cannot pay', () => {
    expect(markingOf({ marksCorrect: 4, marksWrong: 1 })).toEqual({
      marksCorrect: 4,
      marksWrong: 0,
    });
  });
});

describe('scoreAnswers', () => {
  it('uses marks_correct and marks_wrong, not a count of right answers', () => {
    // 10 x 4 - 5 x 1 = 35.
    expect(scoreAnswers(answers({ right: 10, wrong: 5 }), markingOf(CUET))).toBe(35);
  });

  it('scores an unanswered question at nothing, even when it is marked', () => {
    expect(scoreAnswers(answers({ right: 1, marked: 3 }), markingOf(CUET))).toBe(4);
  });

  it('can go negative, because negative marking is real', () => {
    expect(scoreAnswers(answers({ wrong: 3 }), markingOf(CUET))).toBe(-3);
  });

  it('counts right answers when the scheme is unknown, the way it did before', () => {
    expect(scoreAnswers(answers({ right: 7, wrong: 4 }))).toBe(7);
  });

  it('rounds to a whole mark, because attempts.score is an integer column', () => {
    // A third of a mark off per wrong answer: 2 - 3 x 0.33... = 1.
    const third = markingOf({ marksCorrect: 2, marksWrong: -0.33 });
    expect(scoreAnswers(answers({ right: 1, wrong: 3 }), third)).toBe(1);
  });
});

describe('totalMarks', () => {
  it('is the paper s marks, not its question count', () => {
    expect(totalMarks(75, markingOf(CUET))).toBe(300);
    expect(totalMarks(50, markingOf(NET))).toBe(100);
  });

  it('is the question count when the scheme is unknown', () => {
    expect(totalMarks(40)).toBe(40);
    expect(totalMarks(0)).toBe(0);
  });
});

describe('readTopicFilter', () => {
  it('reads a topic id out of the query', () => {
    expect(readTopicFilter(TOPIC)).toBe(TOPIC);
  });

  it('reads Full paper as no filter at all', () => {
    expect(readTopicFilter(MOCK_TOPIC_ALL)).toBeNull();
    expect(readTopicFilter(undefined)).toBeNull();
    expect(readTopicFilter('')).toBeNull();
  });

  it('drops anything that is not a uuid, because the value goes into a URL', () => {
    expect(readTopicFilter('../../secret')).toBeNull();
    expect(readTopicFilter(['a', 'b'])).toBeNull();
    expect(readTopicFilter(7)).toBeNull();
  });
});

describe('readRequestedMode', () => {
  it('defaults to practice, which is this slice', () => {
    expect(readRequestedMode(undefined)).toBe('practice');
    expect(readRequestedMode('nonsense')).toBe('practice');
    expect(readRequestedMode('practice')).toBe('practice');
  });

  it('reads exam, so issue 18 can take over without moving the link', () => {
    expect(readRequestedMode('exam')).toBe('exam');
  });
});

describe('practiceHeading', () => {
  const test = { title: 'Test 2' };

  it('is the exam name then the test name, one muted line', () => {
    expect(
      practiceHeading(test, { nameEn: 'CUET PG Political Science', nameHi: 'x' }, 'en'),
    ).toBe('CUET PG Political Science · Test 2');
  });

  it('shows both names in both mode', () => {
    expect(practiceHeading(test, { nameEn: 'UGC NET', nameHi: 'नेट' }, 'both')).toBe(
      'UGC NET / नेट · Test 2',
    );
  });

  it('is the test name alone when the exam cannot be read', () => {
    expect(practiceHeading(test, null, 'en')).toBe('Test 2');
  });
});
