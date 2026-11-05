/**
 * The attempts contract (issue 13-question-player).
 *
 * Pure functions only, so they are tested without a database and without a
 * browser. The validator is the one that matters: `readAnswerUpsert` is what
 * stands between a POST body and the upsert, and A1 says that upsert has to
 * stay safe to repeat.
 */
import { describe, expect, it } from 'vitest';
import {
  countCorrect,
  isAttemptMode,
  optionLetter,
  playerPath,
  progressLabel,
  readAnswerUpsert,
  verdictOf,
  type AnswerUpsert,
} from '../types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const QUESTION = '22222222-2222-4222-8222-222222222221';

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: ATTEMPT,
    questionId: QUESTION,
    chosenIdx: 1,
    isCorrect: true,
    marked: false,
    ...extra,
  };
}

describe('progressLabel', () => {
  it('reads "12 / 100" on the twelfth question', () => {
    // DESIGN.md section 8: the progress line is Latin digits with a slash.
    expect(progressLabel(11, 100)).toBe('12 / 100');
  });

  it('starts at 1, never 0', () => {
    expect(progressLabel(0, 10)).toBe('1 / 10');
  });

  it('never runs past the total', () => {
    expect(progressLabel(99, 10)).toBe('10 / 10');
  });

  it('says 0 / 0 for an empty paper instead of 1 / 0', () => {
    expect(progressLabel(0, 0)).toBe('0 / 0');
  });
});

describe('optionLetter', () => {
  it('numbers the four options A to D', () => {
    expect([0, 1, 2, 3].map(optionLetter)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('verdictOf', () => {
  it('is true only for the stored correct index', () => {
    expect(verdictOf(2, 2)).toBe(true);
    expect(verdictOf(2, 0)).toBe(false);
  });
});

describe('countCorrect', () => {
  it('counts the right answers and ignores the marked-only ones', () => {
    const answers = new Map([
      ['a', { chosenIdx: 1, isCorrect: true, marked: false }],
      ['b', { chosenIdx: 0, isCorrect: false, marked: false }],
      // Marked for later, never answered: not right and not wrong.
      ['c', { chosenIdx: null, isCorrect: null, marked: true }],
      ['d', { chosenIdx: 3, isCorrect: true, marked: true }],
    ]);
    expect(countCorrect(answers)).toBe(2);
  });
});

describe('isAttemptMode', () => {
  it('takes practice and exam, and nothing else', () => {
    expect(isAttemptMode('practice')).toBe(true);
    expect(isAttemptMode('exam')).toBe(true);
    expect(isAttemptMode('sudden-death')).toBe(false);
    expect(isAttemptMode(null)).toBe(false);
  });
});

describe('playerPath', () => {
  it('gives the paper its own URL, so Back works', () => {
    // DESIGN.md section 7: every test and question page has its own URL.
    expect(playerPath('t1', 'p2')).toBe('/t/t1/papers/p2/play');
  });

  it('escapes both ids', () => {
    expect(playerPath('a/b', 'c d')).toBe('/t/a%2Fb/papers/c%20d/play');
  });
});

describe('readAnswerUpsert', () => {
  it('reads a complete answer', () => {
    const read = readAnswerUpsert(body());
    expect(read).toEqual<AnswerUpsert>({
      attemptId: ATTEMPT,
      questionId: QUESTION,
      chosenIdx: 1,
      isCorrect: true,
      marked: false,
    });
  });

  it('reads a marked-but-unanswered question', () => {
    const read = readAnswerUpsert(body({ chosenIdx: null, isCorrect: null, marked: true }));
    expect(read).toEqual<AnswerUpsert>({
      attemptId: ATTEMPT,
      questionId: QUESTION,
      chosenIdx: null,
      isCorrect: null,
      marked: true,
    });
  });

  it('refuses a chosen option outside 0 to 3', () => {
    expect(readAnswerUpsert(body({ chosenIdx: 4 }))).toBeNull();
    expect(readAnswerUpsert(body({ chosenIdx: -1 }))).toBeNull();
    expect(readAnswerUpsert(body({ chosenIdx: 1.5 }))).toBeNull();
  });

  it('refuses an id that is not a uuid', () => {
    // Both ids go into a REST URL, so the shape is checked before that.
    expect(readAnswerUpsert(body({ attemptId: 'me' }))).toBeNull();
    expect(readAnswerUpsert(body({ questionId: '../../x' }))).toBeNull();
  });

  it('refuses a verdict without a chosen option, the way the CHECK does', () => {
    expect(readAnswerUpsert(body({ chosenIdx: null, isCorrect: true }))).toBeNull();
    expect(readAnswerUpsert(body({ chosenIdx: 2, isCorrect: null }))).toBeNull();
  });

  it('leaves a question unmarked for anything that is not exactly true', () => {
    // Fails closed, the same rule as `readQuestionEdit` in issue 11.
    expect(readAnswerUpsert(body({ marked: 'yes' }))?.marked).toBe(false);
    expect(readAnswerUpsert(body({ marked: undefined }))?.marked).toBe(false);
  });

  it('drops anything else in the body', () => {
    // A caller who sends `userId` or `score` gets their answer stored and no
    // hint that we looked: the owner comes from the session, always.
    const read = readAnswerUpsert(body({ userId: 'someone-else', score: 200 }));
    expect(read).not.toBeNull();
    expect(Object.keys(read as object).sort()).toEqual([
      'attemptId',
      'chosenIdx',
      'isCorrect',
      'marked',
      'questionId',
    ]);
  });

  it('refuses a body that is not an object', () => {
    expect(readAnswerUpsert(null)).toBeNull();
    expect(readAnswerUpsert('answer')).toBeNull();
    expect(readAnswerUpsert([body()])).toBeNull();
  });
});
