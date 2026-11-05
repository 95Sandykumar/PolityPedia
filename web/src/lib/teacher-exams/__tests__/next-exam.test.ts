/**
 * The pill maths (issue 07-next-exam-date-teacher-shell).
 *
 * Definition of done: "students see a pill 'Next exam: NET 18 Dec' on the
 * portfolio", and the issue's test asks for "the nearest future date, past
 * dates hidden".
 *
 * Pure functions with no Date arithmetic inside them: the day is handed in as
 * a plain `YYYY-MM-DD` string, so a test can never drift with the clock or the
 * time zone of the machine that runs it.
 */
import { describe, expect, it } from 'vitest';
import {
  formatExamDate,
  isIsoDate,
  nearestFutureExam,
  nextExamLines,
  todayIso,
  type NextExam,
  type TeacherExam,
} from '../types';

function exam(examId: string, nextExamDate: string | null, label: string | null = null): TeacherExam {
  return { examId, nextExamDate, label };
}

const NET_PILL: NextExam = {
  label: 'NET',
  nameEn: 'UGC NET Political Science',
  nameHi: 'यूजीसी नेट राजनीति विज्ञान',
  date: '2026-12-18',
};

describe('isIsoDate', () => {
  it('accepts a real calendar day', () => {
    expect(isIsoDate('2026-12-18')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of [
      '18-12-2026',
      '2026-12-18T00:00:00Z',
      '2026-13-01',
      '2026-02-30',
      '2026-2-8',
      '',
      null,
      undefined,
      20261218,
    ]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });
});

describe('todayIso', () => {
  it('reads the local day, so a late-evening date is not already tomorrow', () => {
    expect(todayIso(new Date(2026, 11, 18, 23, 30))).toBe('2026-12-18');
    expect(todayIso(new Date(2026, 0, 5, 0, 15))).toBe('2026-01-05');
  });
});

describe('nearestFutureExam', () => {
  const today = '2026-12-01';

  it('picks the nearest of two future dates', () => {
    const picked = nearestFutureExam(
      [exam('a', '2027-06-10', 'CUET'), exam('b', '2026-12-18', 'NET')],
      today,
    );
    expect(picked?.label).toBe('NET');
  });

  it('hides a date that has gone past', () => {
    expect(nearestFutureExam([exam('a', '2026-11-30', 'NET')], today)).toBeNull();
  });

  it('keeps today, because an exam today has not happened yet', () => {
    expect(nearestFutureExam([exam('a', today, 'NET')], today)?.label).toBe('NET');
  });

  it('skips an exam with no date and an empty list', () => {
    expect(nearestFutureExam([exam('a', null, 'PGT')], today)).toBeNull();
    expect(nearestFutureExam([], today)).toBeNull();
  });

  it('ignores a past date even when it is the only one next to a future one', () => {
    const picked = nearestFutureExam(
      [exam('a', '2020-01-01', 'OLD'), exam('b', null, 'NONE'), exam('c', '2027-01-09', 'NEW')],
      today,
    );
    expect(picked?.label).toBe('NEW');
  });
});

describe('formatExamDate', () => {
  it('reads day then short month, Latin digits, no leading zero', () => {
    expect(formatExamDate('2026-12-18', 'en')).toBe('18 Dec');
    expect(formatExamDate('2027-01-09', 'en')).toBe('9 Jan');
  });

  it('has a Hindi month name, with the day still in Latin digits', () => {
    expect(formatExamDate('2026-12-18', 'hi')).toBe('18 दिस');
  });
});

describe('nextExamLines', () => {
  it('reads exactly the pill the PRD sketch shows', () => {
    expect(nextExamLines(NET_PILL, 'en')).toEqual(['Next exam: NET 18 Dec']);
  });

  it('is Hindi end to end in hi mode', () => {
    expect(nextExamLines(NET_PILL, 'hi')).toEqual(['अगली परीक्षा: NET 18 दिस']);
  });

  it('gives two lines in both mode, English first', () => {
    const lines = nextExamLines(NET_PILL, 'both');
    expect(lines).toEqual(['Next exam: NET 18 Dec', 'अगली परीक्षा: NET 18 दिस']);
  });

  it('falls back to the exam name in the right language when there is no short label', () => {
    const noLabel: NextExam = { ...NET_PILL, label: null };
    expect(nextExamLines(noLabel, 'en')).toEqual(['Next exam: UGC NET Political Science 18 Dec']);
    expect(nextExamLines(noLabel, 'hi')).toEqual([
      'अगली परीक्षा: यूजीसी नेट राजनीति विज्ञान 18 दिस',
    ]);
  });
});
