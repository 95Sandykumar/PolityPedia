/**
 * The questions contract (issue 11-ingest-job-review-publish).
 *
 * Two rules carry the whole slice, so they are tested on their own here,
 * away from any screen:
 *
 *  * `readOptions` -- exactly 4 filled-in strings, the same rule as the
 *    `questions_options_check` constraint in 0011.
 *  * `publishBlock` -- why Publish is off. The UI disables the button with it
 *    and `publish_paper()` raises on the same two reasons, so the screen and
 *    the database can never disagree.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_QUESTIONS_PER_PAPER,
  isIngestJobStatus,
  isJobBusy,
  isQuestionStatus,
  nextQuestionNumber,
  publishBlock,
  readOptions,
  readQuestionEdit,
  type IngestJob,
  type Question,
} from '../types';

const PAPER = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';

const FOUR = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    teacherId: TEACHER,
    paperId: PAPER,
    testId: null,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    correctIdx: 1,
    teacherExplanation: null,
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: false,
    status: 'draft',
    ...over,
  };
}

function job(over: Partial<IngestJob> = {}): IngestJob {
  return {
    id: 'j1',
    teacherId: TEACHER,
    paperId: PAPER,
    pdfPath: 'papers/q.pdf',
    status: 'queued',
    attempts: 0,
    error: null,
    questionCount: 0,
    ...over,
  };
}

describe('isIngestJobStatus / isJobBusy', () => {
  it('knows the four job statuses and nothing else', () => {
    for (const status of ['queued', 'running', 'done', 'failed']) {
      expect(isIngestJobStatus(status)).toBe(true);
    }
    for (const status of ['splitting', '', null, 7]) {
      expect(isIngestJobStatus(status)).toBe(false);
    }
  });

  it('calls only queued and running busy', () => {
    expect(isJobBusy('queued')).toBe(true);
    expect(isJobBusy('running')).toBe(true);
    expect(isJobBusy('done')).toBe(false);
    // A failed split is over. The teacher may still add questions by hand.
    expect(isJobBusy('failed')).toBe(false);
  });
});

describe('isQuestionStatus', () => {
  it('accepts draft and live only', () => {
    expect(isQuestionStatus('draft')).toBe(true);
    expect(isQuestionStatus('live')).toBe(true);
    expect(isQuestionStatus('published')).toBe(false);
    expect(isQuestionStatus(undefined)).toBe(false);
  });
});

describe('readOptions', () => {
  it('takes exactly four filled-in strings', () => {
    expect(readOptions(FOUR)).toEqual(FOUR);
  });

  it('refuses three or five', () => {
    expect(readOptions(['a', 'b', 'c'])).toBeNull();
    expect(readOptions(['a', 'b', 'c', 'd', 'e'])).toBeNull();
  });

  it('refuses a blank option, however it is spelled', () => {
    expect(readOptions(['a', 'b', 'c', ''])).toBeNull();
    expect(readOptions(['a', 'b', 'c', '   '])).toBeNull();
  });

  it('refuses something that is not four strings', () => {
    expect(readOptions(['a', 'b', 'c', 7])).toBeNull();
    expect(readOptions('abcd')).toBeNull();
    expect(readOptions(null)).toBeNull();
    expect(readOptions({ 0: 'a' })).toBeNull();
  });

  it('trims every option, so a trailing space is not stored', () => {
    expect(readOptions([' a ', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('readQuestionEdit', () => {
  const good = {
    id: null,
    paperId: PAPER,
    number: 3,
    stem: '  Who appoints the Governor?  ',
    options: FOUR,
    correctIdx: 2,
    teacherExplanation: ' Article 155. ',
    lang: 'en',
    checked: true,
  };

  it('reads a good body and trims the text', () => {
    expect(readQuestionEdit(good)).toEqual({
      id: null,
      paperId: PAPER,
      number: 3,
      stem: 'Who appoints the Governor?',
      options: FOUR,
      correctIdx: 2,
      teacherExplanation: 'Article 155.',
      lang: 'en',
      checked: true,
    });
  });

  it('keeps an existing question id', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(readQuestionEdit({ ...good, id })?.id).toBe(id);
  });

  it('turns a blank explanation into null, never an empty string', () => {
    expect(readQuestionEdit({ ...good, teacherExplanation: '   ' })?.teacherExplanation).toBeNull();
    expect(readQuestionEdit({ ...good, teacherExplanation: undefined })?.teacherExplanation).toBeNull();
  });

  it('refuses a paper id that is not a uuid', () => {
    expect(readQuestionEdit({ ...good, paperId: 'paper-1' })).toBeNull();
    expect(readQuestionEdit({ ...good, paperId: null })).toBeNull();
  });

  it('refuses a question id that is not a uuid', () => {
    expect(readQuestionEdit({ ...good, id: 'q1' })).toBeNull();
  });

  it('refuses a number outside 1 to 200', () => {
    expect(readQuestionEdit({ ...good, number: 0 })).toBeNull();
    expect(readQuestionEdit({ ...good, number: MAX_QUESTIONS_PER_PAPER + 1 })).toBeNull();
    expect(readQuestionEdit({ ...good, number: 1.5 })).toBeNull();
  });

  it('refuses a blank stem', () => {
    expect(readQuestionEdit({ ...good, stem: '   ' })).toBeNull();
  });

  it('refuses options that are not exactly four', () => {
    expect(readQuestionEdit({ ...good, options: ['a', 'b', 'c'] })).toBeNull();
  });

  it('refuses a correct answer outside 0 to 3', () => {
    expect(readQuestionEdit({ ...good, correctIdx: 4 })).toBeNull();
    expect(readQuestionEdit({ ...good, correctIdx: -1 })).toBeNull();
    expect(readQuestionEdit({ ...good, correctIdx: '1' })).toBeNull();
  });

  it('refuses a language the app has no labels for', () => {
    expect(readQuestionEdit({ ...good, lang: 'ta' })).toBeNull();
    expect(readQuestionEdit({ ...good, lang: 'both' })).toBeNull();
  });

  it('defaults checked to false, so a body cannot check a question by omission', () => {
    const edit = readQuestionEdit({ ...good, checked: undefined });
    expect(edit?.checked).toBe(false);
  });

  it('drops a status or a teacher id in the body', () => {
    const edit = readQuestionEdit({ ...good, status: 'live', teacherId: TEACHER });
    expect(edit).not.toBeNull();
    expect(Object.keys(edit ?? {}).sort()).toEqual([
      'checked',
      'correctIdx',
      'id',
      'lang',
      'number',
      'options',
      'paperId',
      'stem',
      'teacherExplanation',
    ]);
  });

  it('refuses a body that is not an object', () => {
    expect(readQuestionEdit(null)).toBeNull();
    expect(readQuestionEdit('q')).toBeNull();
  });
});

describe('publishBlock', () => {
  it('is clear when every question is checked and the split is done', () => {
    expect(
      publishBlock({
        job: job({ status: 'done', questionCount: 2 }),
        questions: [question({ checked: true }), question({ id: 'q2', checked: true })],
      }),
    ).toBeNull();
  });

  it('blocks while the split is queued or running (Risk 1)', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(publishBlock({ job: job({ status }), questions: [] })).toBe('splitting');
    }
  });

  it('blocks on one unchecked question (F-D3)', () => {
    expect(
      publishBlock({
        job: null,
        questions: [question({ checked: true }), question({ id: 'q2', checked: false })],
      }),
    ).toBe('unchecked');
  });

  it('reports the split first, because it is the reason that will clear itself', () => {
    expect(
      publishBlock({ job: job({ status: 'running' }), questions: [question()] }),
    ).toBe('splitting');
  });

  it('is clear for a paper with no questions at all, because the PDF is content', () => {
    expect(publishBlock({ job: null, questions: [] })).toBeNull();
  });

  it('is clear when the split failed, so the teacher is not stuck', () => {
    expect(
      publishBlock({ job: job({ status: 'failed', error: 'Claude said no' }), questions: [] }),
    ).toBeNull();
  });
});

describe('nextQuestionNumber', () => {
  it('is 1 for an empty paper', () => {
    expect(nextQuestionNumber([])).toBe(1);
  });

  it('is one past the highest number, not the count', () => {
    expect(
      nextQuestionNumber([question({ number: 1 }), question({ id: 'q2', number: 7 })]),
    ).toBe(8);
  });

  it('never goes past the 200 cap', () => {
    expect(nextQuestionNumber([question({ number: MAX_QUESTIONS_PER_PAPER })])).toBe(
      MAX_QUESTIONS_PER_PAPER,
    );
  });
});
