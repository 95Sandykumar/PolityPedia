/**
 * The exam-mode contract (issue 18-exam-mode).
 *
 * THE KEY TEST IS THE FIRST BLOCK. F-E5 says the answer key never reaches the
 * phone before submit, so `stripAnswerKey` is checked by SEARCHING THE WHOLE
 * SERIALISED PAYLOAD, not by reading two fields: a field added to `Question`
 * next month has to fail this test, not slip past it.
 *
 * Everything here is pure, so no test in this file touches the network or a
 * key (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import {
  AMBER_MS,
  carriesAnswerKey,
  deadlineFor,
  examAnswerPath,
  examLoadPath,
  examQuestions,
  examSubmitPath,
  gridState,
  gridStates,
  readDurationMin,
  readExamAnswer,
  remainingMs,
  stripAnswerKey,
  timerLabel,
  timerTone,
} from '../types';
import type { AttemptAnswer } from '@/lib/attempts/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

const OPTIONS: QuestionOptions = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];

function question(number: number, correctIdx = 1): Question {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${number}`,
    teacherId: TEACHER,
    paperId: null,
    testId: TEST,
    number,
    stem: `Question ${number}`,
    options: OPTIONS,
    correctIdx,
    teacherExplanation: 'Article 80 names the Council of States.',
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'live',
  };
}

// --------------------------------------------------------------------------
// F-E5: the answer key never reaches the phone before submit
// --------------------------------------------------------------------------
describe('stripAnswerKey', () => {
  it('drops correctIdx and teacherExplanation', () => {
    const stripped = stripAnswerKey(question(1, 2)) as Record<string, unknown>;

    expect('correctIdx' in stripped).toBe(false);
    expect('teacherExplanation' in stripped).toBe(false);
  });

  it('keeps everything the student actually needs to answer', () => {
    const stripped = stripAnswerKey(question(7, 2));

    expect(stripped.id).toBe(question(7).id);
    expect(stripped.number).toBe(7);
    expect(stripped.stem).toBe('Question 7');
    expect(stripped.options).toEqual(OPTIONS);
    expect(stripped.lang).toBe('en');
  });

  it('leaves no trace of the key anywhere in the serialised payload', () => {
    const wire = JSON.stringify(stripAnswerKey(question(1, 3)));

    expect(wire).not.toContain('correct');
    expect(wire).not.toContain('explanation');
    expect(wire).not.toContain('Article 80');
  });

  it('does not change the question it was handed', () => {
    const original = question(1, 2);
    stripAnswerKey(original);

    expect(original.correctIdx).toBe(2);
    expect(original.teacherExplanation).toBeTruthy();
  });
});

describe('carriesAnswerKey', () => {
  it('finds a key in a nested payload, in either spelling', () => {
    expect(carriesAnswerKey({ questions: [question(1)] })).toBe(true);
    expect(carriesAnswerKey({ rows: [{ correct_idx: 2 }] })).toBe(true);
    expect(carriesAnswerKey({ rows: [{ teacher_explanation: 'x' }] })).toBe(true);
  });

  it('is happy with a stripped payload', () => {
    expect(carriesAnswerKey({ questions: [stripAnswerKey(question(1))] })).toBe(false);
  });

  it('is happy with the things that are not a key', () => {
    expect(carriesAnswerKey(null)).toBe(false);
    expect(carriesAnswerKey({ marking: { marksCorrect: 4, marksWrong: -1 } })).toBe(false);
    expect(carriesAnswerKey({ answers: [['q', { chosenIdx: 1, marked: false }]] })).toBe(
      false,
    );
  });
});

describe('examQuestions', () => {
  const paper = [question(1, 0), question(2, 3)];

  it('strips every question while the sitting is still open', () => {
    const out = examQuestions(paper, false);

    expect(out).toHaveLength(2);
    expect(carriesAnswerKey(out)).toBe(false);
  });

  it('hands the key over once the sitting is submitted, for the review', () => {
    const out = examQuestions(paper, true);

    expect(carriesAnswerKey(out)).toBe(true);
    expect((out[1] as Question).correctIdx).toBe(3);
    expect((out[1] as Question).teacherExplanation).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// The timer
// --------------------------------------------------------------------------
describe('deadlineFor', () => {
  it('is the start plus the test duration', () => {
    const now = Date.parse('2026-11-05T10:00:00.000Z');

    expect(deadlineFor(90, now)).toBe('2026-11-05T11:30:00.000Z');
  });

  it('falls back to the default duration for a number it cannot use', () => {
    const now = Date.parse('2026-11-05T10:00:00.000Z');

    expect(deadlineFor(0, now)).toBe(deadlineFor(readDurationMin(null), now));
    expect(deadlineFor(Number.NaN, now)).toBe(deadlineFor(readDurationMin(null), now));
  });
});

describe('readDurationMin', () => {
  it('keeps a duration inside the band mock_tests_duration_check allows', () => {
    expect(readDurationMin(90)).toBe(90);
    expect(readDurationMin(1)).toBe(1);
    expect(readDurationMin(360)).toBe(360);
  });

  it('refuses a duration outside it rather than drawing a wrong clock', () => {
    expect(readDurationMin(0)).toBe(60);
    expect(readDurationMin(-5)).toBe(60);
    expect(readDurationMin(10_000)).toBe(60);
    expect(readDurationMin('90')).toBe(60);
    expect(readDurationMin(null)).toBe(60);
  });
});

describe('remainingMs', () => {
  const now = Date.parse('2026-11-05T10:00:00.000Z');

  it('is the time left on the clock', () => {
    expect(remainingMs('2026-11-05T10:05:00.000Z', now)).toBe(5 * 60 * 1000);
  });

  it('is null when there is no clock at all, which is practice mode', () => {
    expect(remainingMs(null, now)).toBeNull();
  });

  it('never goes below zero, so the screen cannot show a negative clock', () => {
    expect(remainingMs('2026-11-05T09:00:00.000Z', now)).toBe(0);
  });

  it('reads an unreadable deadline as no time left, never as all day', () => {
    expect(remainingMs('not a date', now)).toBe(0);
  });
});

describe('timerTone', () => {
  it('is calm with plenty of time left', () => {
    expect(timerTone(30 * 60 * 1000)).toBe('calm');
  });

  it('turns amber under 5 minutes (DESIGN.md section 8)', () => {
    expect(timerTone(AMBER_MS - 1)).toBe('amber');
    expect(timerTone(60 * 1000)).toBe('amber');
    // Exactly 5 minutes is not yet "under" 5 minutes.
    expect(timerTone(AMBER_MS)).toBe('calm');
  });

  it('is over at zero', () => {
    expect(timerTone(0)).toBe('over');
  });

  it('is calm with no clock, because there is nothing to warn about', () => {
    expect(timerTone(null)).toBe('calm');
  });
});

describe('timerLabel', () => {
  it('is minutes and seconds under an hour, in Latin digits', () => {
    expect(timerLabel(5 * 60 * 1000)).toBe('05:00');
    expect(timerLabel(59 * 1000)).toBe('00:59');
    expect(timerLabel(0)).toBe('00:00');
  });

  it('grows an hours field for a 3-hour paper', () => {
    expect(timerLabel(90 * 60 * 1000)).toBe('1:30:00');
    expect(timerLabel(3 * 3600 * 1000)).toBe('3:00:00');
  });

  it('rounds down, so the clock never shows a second the student does not have', () => {
    expect(timerLabel(1999)).toBe('00:01');
  });
});

// --------------------------------------------------------------------------
// The question-number grid (D2)
// --------------------------------------------------------------------------
describe('gridState', () => {
  const answered: AttemptAnswer = { chosenIdx: 2, isCorrect: null, marked: false };
  const marked: AttemptAnswer = { chosenIdx: null, isCorrect: null, marked: true };
  const both: AttemptAnswer = { chosenIdx: 1, isCorrect: null, marked: true };

  it('is unseen with no row at all', () => {
    expect(gridState(undefined)).toBe('unseen');
  });

  it('is answered with a chosen option', () => {
    expect(gridState(answered)).toBe('answered');
  });

  it('is marked when it is only marked for later', () => {
    expect(gridState(marked)).toBe('marked');
  });

  it('shows marked first when it is both, because that is what a student hunts for', () => {
    expect(gridState(both)).toBe('marked');
  });

  it('is unseen for a row that holds neither', () => {
    expect(gridState({ chosenIdx: null, isCorrect: null, marked: false })).toBe('unseen');
  });
});

describe('gridStates', () => {
  it('is one state per question, in the order the paper runs', () => {
    const paper = [question(1), question(2), question(3)];
    const answers = new Map<string, AttemptAnswer>([
      [paper[0].id, { chosenIdx: 0, isCorrect: null, marked: false }],
      [paper[2].id, { chosenIdx: null, isCorrect: null, marked: true }],
    ]);

    expect(gridStates(paper, answers)).toEqual(['answered', 'unseen', 'marked']);
  });
});

// --------------------------------------------------------------------------
// The exam answer body: it has no verdict field at all
// --------------------------------------------------------------------------
describe('readExamAnswer', () => {
  const body = (extra: Record<string, unknown>) => ({
    attemptId: ATTEMPT,
    questionId: question(1).id,
    ...extra,
  });

  it('reads a chosen option with no verdict, which is the whole point', () => {
    expect(readExamAnswer(body({ chosenIdx: 2 }))).toEqual({
      attemptId: ATTEMPT,
      questionId: question(1).id,
      chosenIdx: 2,
      marked: false,
    });
  });

  it('reads marked for later with nothing chosen', () => {
    expect(readExamAnswer(body({ chosenIdx: null, marked: true }))).toEqual({
      attemptId: ATTEMPT,
      questionId: question(1).id,
      chosenIdx: null,
      marked: true,
    });
  });

  it('DROPS an isCorrect a caller sends, so a phone cannot mark its own paper', () => {
    const read = readExamAnswer(body({ chosenIdx: 2, isCorrect: true }));

    expect(read).not.toBeNull();
    expect(read as unknown as Record<string, unknown>).not.toHaveProperty('isCorrect');
  });

  it('drops a score and a userId too, the same way', () => {
    const read = readExamAnswer(body({ chosenIdx: 1, score: 800, userId: ATTEMPT }));

    expect(read).toEqual({
      attemptId: ATTEMPT,
      questionId: question(1).id,
      chosenIdx: 1,
      marked: false,
    });
  });

  it('refuses an id that is not a uuid, because it goes into a URL', () => {
    expect(readExamAnswer(body({ chosenIdx: 1, attemptId: '../../x' }))).toBeNull();
    expect(readExamAnswer({ attemptId: ATTEMPT, questionId: 'x', chosenIdx: 1 })).toBeNull();
  });

  it('refuses a chosen option outside 0 to 3', () => {
    expect(readExamAnswer(body({ chosenIdx: 4 }))).toBeNull();
    expect(readExamAnswer(body({ chosenIdx: -1 }))).toBeNull();
    expect(readExamAnswer(body({ chosenIdx: 1.5 }))).toBeNull();
    expect(readExamAnswer(body({ chosenIdx: '1' }))).toBeNull();
  });

  it('refuses a body that is not an object', () => {
    expect(readExamAnswer(null)).toBeNull();
    expect(readExamAnswer('{}')).toBeNull();
    expect(readExamAnswer([])).toBeNull();
  });

  it('fails closed on marked: anything but true is unmarked', () => {
    expect(readExamAnswer(body({ chosenIdx: 1, marked: 'yes' }))?.marked).toBe(false);
    expect(readExamAnswer(body({ chosenIdx: 1, marked: 1 }))?.marked).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Our own routes
// --------------------------------------------------------------------------
describe('the exam route paths', () => {
  it('load carries the mode and, when there is one, the topic', () => {
    expect(examLoadPath(TEST)).toBe(`/api/tests/${TEST}/load?mode=exam`);
    expect(examLoadPath(TEST, { topicId: 'all' })).toBe(`/api/tests/${TEST}/load?mode=exam`);
    expect(examLoadPath(TEST, { topicId: ATTEMPT })).toBe(
      `/api/tests/${TEST}/load?mode=exam&topic=${ATTEMPT}`,
    );
  });

  it('answer and submit hang off the same test', () => {
    expect(examAnswerPath(TEST)).toBe(`/api/tests/${TEST}/answer`);
    expect(examSubmitPath(TEST)).toBe(`/api/tests/${TEST}/submit`);
  });

  it('escapes a test id rather than pasting it into a URL', () => {
    expect(examAnswerPath('a/b')).toBe('/api/tests/a%2Fb/answer');
  });
});
