/**
 * Reading the model's answer (issue 12-pdf-split-worker).
 *
 * `readSplitAnswer` is the gate for Risk 1: a wrong answer out of the split
 * must not reach a student. It fails CLOSED, so every case below that is not
 * exactly the schema comes back as a reason, never as a half-built question.
 */
import { describe, expect, it } from 'vitest';
import { MAX_EXPLANATION_LENGTH, MAX_STEM_LENGTH } from '@/lib/questions/types';
import {
  MAX_QUESTIONS_PER_PAPER,
  isRetryable,
  isSplitFailure,
  readSplitAnswer,
  readSplitQuestion,
} from '../types';

const GOOD = {
  stem: 'Who appoints the Governor of a state?',
  options: ['President', 'Prime Minister', 'Chief Minister', 'Chief Justice'],
  correct_idx: 0,
  explanation: 'Article 155.',
};

describe('readSplitQuestion', () => {
  it('reads a well-formed question', () => {
    expect(readSplitQuestion(GOOD)).toEqual({
      stem: 'Who appoints the Governor of a state?',
      options: ['President', 'Prime Minister', 'Chief Minister', 'Chief Justice'],
      correctIdx: 0,
      explanation: 'Article 155.',
    });
  });

  it('trims the stem and the options, and turns a blank explanation into null', () => {
    const question = readSplitQuestion({
      ...GOOD,
      stem: '  Who appoints the Governor?  ',
      options: [' President ', 'PM', 'CM', 'CJ'],
      explanation: '   ',
    });
    expect(question?.stem).toBe('Who appoints the Governor?');
    expect(question?.options[0]).toBe('President');
    // "No explanation" is ONE value, never an empty string.
    expect(question?.explanation).toBeNull();
  });

  it('accepts a missing explanation', () => {
    expect(readSplitQuestion({ ...GOOD, explanation: null })?.explanation).toBeNull();
    const { explanation, ...withoutIt } = GOOD;
    expect(explanation).toBeTruthy();
    expect(readSplitQuestion(withoutIt)?.explanation).toBeNull();
  });

  it('cuts an over-long explanation instead of losing the question', () => {
    const question = readSplitQuestion({ ...GOOD, explanation: 'x'.repeat(99_999) });
    expect(question?.explanation).toHaveLength(MAX_EXPLANATION_LENGTH);
  });

  it.each([
    ['not an object', 'nope'],
    ['no stem', { ...GOOD, stem: undefined }],
    ['blank stem', { ...GOOD, stem: '   ' }],
    ['giant stem', { ...GOOD, stem: 'x'.repeat(MAX_STEM_LENGTH + 1) }],
    ['three options', { ...GOOD, options: ['a', 'b', 'c'] }],
    ['five options', { ...GOOD, options: ['a', 'b', 'c', 'd', 'e'] }],
    ['a blank option', { ...GOOD, options: ['a', '', 'c', 'd'] }],
    ['a numeric option', { ...GOOD, options: ['a', 2, 'c', 'd'] }],
    ['no answer', { ...GOOD, correct_idx: undefined }],
    ['a letter answer', { ...GOOD, correct_idx: 'A' }],
    ['answer 4', { ...GOOD, correct_idx: 4 }],
    ['answer -1', { ...GOOD, correct_idx: -1 }],
    ['a fractional answer', { ...GOOD, correct_idx: 1.5 }],
    ['an object explanation', { ...GOOD, explanation: { text: 'hi' } }],
  ])('refuses %s', (_label, value) => {
    expect(readSplitQuestion(value)).toBeNull();
  });
});

describe('readSplitAnswer', () => {
  it('reads a list of questions', () => {
    const reading = readSplitAnswer({ questions: [GOOD, { ...GOOD, correct_idx: 3 }] });
    expect(reading.ok).toBe(true);
    expect(reading.ok && reading.questions).toHaveLength(2);
  });

  it.each([
    ['a string', 'the paper has 50 questions'],
    ['null', null],
    ['no questions key', { items: [GOOD] }],
    ['questions that is not an array', { questions: GOOD }],
  ])('calls %s a bad answer', (_label, value) => {
    expect(readSplitAnswer(value)).toEqual({ ok: false, reason: 'bad-answer' });
  });

  it('refuses the WHOLE answer when one question is wrong', () => {
    // Not "keep the good ones": a silently dropped question is a gap the
    // teacher cannot see, and the retry is cheap.
    const reading = readSplitAnswer({ questions: [GOOD, { ...GOOD, options: ['a'] }, GOOD] });
    expect(reading).toEqual({ ok: false, reason: 'bad-answer' });
  });

  it('reports an empty paper as no-questions, not as a bad answer', () => {
    expect(readSplitAnswer({ questions: [] })).toEqual({ ok: false, reason: 'no-questions' });
  });

  it('takes 200 questions and refuses 201 (F-D2)', () => {
    const list = (count: number) => ({
      questions: Array.from({ length: count }, () => GOOD),
    });

    const atCap = readSplitAnswer(list(MAX_QUESTIONS_PER_PAPER));
    expect(atCap.ok).toBe(true);
    expect(atCap.ok && atCap.questions).toHaveLength(MAX_QUESTIONS_PER_PAPER);

    // Refused, never truncated: half a paper looks finished to the teacher.
    expect(readSplitAnswer(list(MAX_QUESTIONS_PER_PAPER + 1))).toEqual({
      ok: false,
      reason: 'too-many',
    });
  });
});

describe('isRetryable', () => {
  it('retries what a second try could fix', () => {
    expect(isRetryable('bad-answer')).toBe(true);
    expect(isRetryable('splitter-error')).toBe(true);
    expect(isRetryable('no-questions')).toBe(true);
  });

  it('does not retry a deterministic refusal', () => {
    // The same PDF gives the same 201 questions, and a deleted object stays
    // deleted, so three calls would cost three times as much for one answer.
    expect(isRetryable('too-many')).toBe(false);
    expect(isRetryable('no-pdf')).toBe(false);
    expect(isRetryable('write-failed')).toBe(false);
  });
});

describe('isSplitFailure', () => {
  it('knows its own codes and nothing else', () => {
    expect(isSplitFailure('bad-answer')).toBe(true);
    expect(isSplitFailure('write-failed')).toBe(true);
    expect(isSplitFailure('something the model said')).toBe(false);
    expect(isSplitFailure(null)).toBe(false);
  });
});
