/**
 * The saved contract (issue 14-saved-list).
 *
 * F-E8: one list, two tags. Everything here is pure, so the chip filter and
 * the body validation are proved without a DOM and without a network call.
 */
import { describe, expect, it } from 'vitest';
import {
  SAVED_TAGS,
  countByTag,
  filterSaved,
  isSavedTag,
  readSavedWrite,
  type SavedItem,
} from '../types';

const Q1 = '22222222-2222-4222-8222-222222222221';
const Q2 = '22222222-2222-4222-8222-222222222222';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';

function item(values: Partial<SavedItem> & { questionId: string }): SavedItem {
  return {
    tag: 'wrong',
    createdAt: '2026-11-05T10:00:00.000Z',
    teacherId: TEACHER,
    paperId: PAPER,
    number: 1,
    stem: 'Which house is the Council of States?',
    ...values,
  };
}

describe('the two tags', () => {
  it('is Wrong and Marked, in that order', () => {
    expect(SAVED_TAGS).toEqual(['wrong', 'marked']);
  });

  it('refuses anything else', () => {
    expect(isSavedTag('wrong')).toBe(true);
    expect(isSavedTag('marked')).toBe(true);
    expect(isSavedTag('later')).toBe(false);
    expect(isSavedTag(1)).toBe(false);
    expect(isSavedTag(null)).toBe(false);
  });
});

describe('readSavedWrite', () => {
  it('reads a question id, a tag and the wanted state', () => {
    expect(readSavedWrite({ questionId: Q1, tag: 'wrong', saved: true })).toEqual({
      questionId: Q1,
      tag: 'wrong',
      saved: true,
    });
    expect(readSavedWrite({ questionId: Q1, tag: 'marked', saved: false })).toEqual({
      questionId: Q1,
      tag: 'marked',
      saved: false,
    });
  });

  it('refuses a question id that is not a uuid', () => {
    expect(readSavedWrite({ questionId: 'q1', tag: 'wrong', saved: true })).toBeNull();
    expect(readSavedWrite({ questionId: 7, tag: 'wrong', saved: true })).toBeNull();
  });

  it('refuses a tag the table would not take', () => {
    expect(readSavedWrite({ questionId: Q1, tag: 'later', saved: true })).toBeNull();
    expect(readSavedWrite({ questionId: Q1, saved: true })).toBeNull();
  });

  it('wants a real boolean, so the string "false" is not a yes', () => {
    expect(readSavedWrite({ questionId: Q1, tag: 'wrong', saved: 'false' })).toBeNull();
    expect(readSavedWrite({ questionId: Q1, tag: 'wrong' })).toBeNull();
  });

  it('drops a userId in the body: the owner comes from the session', () => {
    const read = readSavedWrite({
      questionId: Q1,
      tag: 'wrong',
      saved: true,
      userId: '99999999-9999-4999-8999-999999999999',
    });
    expect(read).toEqual({ questionId: Q1, tag: 'wrong', saved: true });
  });

  it('refuses a body that is not an object', () => {
    expect(readSavedWrite(null)).toBeNull();
    expect(readSavedWrite('wrong')).toBeNull();
    expect(readSavedWrite([{ questionId: Q1, tag: 'wrong', saved: true }])).toBeNull();
  });
});

describe('the filter chips', () => {
  const items = [
    item({ questionId: Q1, tag: 'wrong' }),
    item({ questionId: Q2, tag: 'marked', number: 2 }),
    item({ questionId: Q2, tag: 'wrong', number: 2 }),
  ];

  it('shows both tags when no chip is picked', () => {
    expect(filterSaved(items, null)).toHaveLength(3);
  });

  it('narrows to one tag when a chip is picked', () => {
    expect(filterSaved(items, 'marked').map((one) => one.questionId)).toEqual([Q2]);
    expect(filterSaved(items, 'wrong').map((one) => one.questionId)).toEqual([Q1, Q2]);
  });

  it('counts each tag for the chip label', () => {
    expect(countByTag(items, 'wrong')).toBe(2);
    expect(countByTag(items, 'marked')).toBe(1);
    expect(countByTag([], 'wrong')).toBe(0);
  });
});
