/**
 * Past paper contracts: the 30 MB gate and the Exam > Year > Month grouping
 * (issue 10-papers-upload-browse).
 *
 * Pure functions, so these run with no database and no network.
 */
import { describe, expect, it } from 'vitest';
import type { Exam } from '@/lib/exams/types';
import {
  checkPdf,
  groupPapers,
  MAX_PDF_BYTES,
  monthLabels,
  paperDownloadPath,
  paperPdfPath,
  type Paper,
} from '../types';

const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';
const TEACHER = '44444444-4444-4444-8444-444444444444';

function exam(id: string, nameEn: string, nameHi: string): Exam {
  return {
    id,
    code: nameEn.toLowerCase(),
    nameEn,
    nameHi,
    marksCorrect: null,
    marksWrong: null,
    durationMin: null,
    questionCount: null,
    markingUnverified: false,
  };
}

const EXAMS: Exam[] = [
  exam(NET, 'UGC NET Political Science', 'यूजीसी नेट राजनीति विज्ञान'),
  exam(CUET, 'CUET PG Political Science', 'सीयूईटी पीजी राजनीति विज्ञान'),
];

let next = 0;
function paper(values: Partial<Paper> = {}): Paper {
  next += 1;
  return {
    id: `p${next}`,
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: null,
    label: 'Paper ' + next,
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'live',
    ...values,
  };
}

describe('checkPdf', () => {
  it('accepts a normal PDF', () => {
    expect(checkPdf({ name: 'net-2024.pdf', type: 'application/pdf', size: 2_000_000 })).toBeNull();
  });

  it('accepts a PDF exactly on the 30 MB line', () => {
    expect(MAX_PDF_BYTES).toBe(30 * 1024 * 1024);
    expect(checkPdf({ name: 'q.pdf', type: 'application/pdf', size: MAX_PDF_BYTES })).toBeNull();
  });

  it('refuses a 31 MB file', () => {
    const size = 31 * 1024 * 1024;
    expect(size).toBeGreaterThan(MAX_PDF_BYTES);
    expect(checkPdf({ name: 'q.pdf', type: 'application/pdf', size })).toBe('too-big');
  });

  it('refuses an empty file', () => {
    expect(checkPdf({ name: 'q.pdf', type: 'application/pdf', size: 0 })).toBe('empty');
  });

  it('refuses something that is not a PDF', () => {
    expect(checkPdf({ name: 'scan.jpg', type: 'image/jpeg', size: 1000 })).toBe('not-pdf');
  });

  it('trusts the .pdf extension when the phone sends no type', () => {
    expect(checkPdf({ name: 'q.PDF', type: '', size: 1000 })).toBeNull();
    expect(
      checkPdf({ name: 'q.pdf', type: 'application/octet-stream', size: 1000 }),
    ).toBeNull();
  });
});

describe('paperPdfPath', () => {
  it('puts the file under the teacher own folder', () => {
    const path = paperPdfPath(TEACHER, 'questions', 'abc123');
    expect(path).toBe(`${TEACHER}/abc123-questions.pdf`);
  });

  it('refuses a teacher id that is not a uuid, so a path cannot be steered', () => {
    expect(() => paperPdfPath('../other', 'questions', 'abc123')).toThrow();
    expect(() => paperPdfPath(TEACHER, 'questions', '../../etc/passwd')).toThrow();
  });
});

describe('paperDownloadPath', () => {
  it('points at our own route, with the kind in the query', () => {
    expect(paperDownloadPath('p1', 'solutions')).toBe('/api/papers/p1/download?kind=solutions');
  });
});

describe('monthLabels', () => {
  it('gives a short month name in both languages', () => {
    expect(monthLabels(6, 'en')).toEqual(['Jun']);
    expect(monthLabels(6, 'hi')).toEqual(['जून']);
    expect(monthLabels(12, 'both')).toEqual(['Dec', 'दिस']);
  });
});

describe('groupPapers', () => {
  it('groups Exam > Year > Month, newest year first', () => {
    const groups = groupPapers(
      [
        paper({ examId: NET, year: 2023, month: 6, label: 'Shift 1' }),
        paper({ examId: NET, year: 2025, month: 1, label: 'Shift 1' }),
        paper({ examId: NET, year: 2025, month: 12, label: 'Shift 1' }),
        paper({ examId: CUET, year: 2024, month: null, label: 'Full paper' }),
      ],
      EXAMS,
    );

    expect(groups.map((g) => g.examId)).toEqual([NET, CUET]);
    expect(groups[0].nameEn).toBe('UGC NET Political Science');
    expect(groups[0].years.map((y) => y.year)).toEqual([2025, 2023]);
    expect(groups[0].years[0].months.map((m) => m.month)).toEqual([12, 1]);
    expect(groups[1].years[0].months.map((m) => m.month)).toEqual([null]);
  });

  it('keeps the exam order of the catalogue, not the order papers arrived in', () => {
    const groups = groupPapers(
      [paper({ examId: CUET }), paper({ examId: NET })],
      EXAMS,
    );
    expect(groups.map((g) => g.examId)).toEqual([NET, CUET]);
  });

  it('puts a paper with no month after the months of the same year', () => {
    const groups = groupPapers(
      [
        paper({ year: 2024, month: null, label: 'Whole year' }),
        paper({ year: 2024, month: 6, label: 'Jun shift' }),
      ],
      EXAMS,
    );
    expect(groups[0].years[0].months.map((m) => m.month)).toEqual([6, null]);
  });

  it('sorts papers inside one month by label, so the order never jumps', () => {
    const groups = groupPapers(
      [
        paper({ year: 2024, month: 6, label: 'Shift 2' }),
        paper({ year: 2024, month: 6, label: 'Shift 1' }),
      ],
      EXAMS,
    );
    expect(groups[0].years[0].months[0].papers.map((p) => p.label)).toEqual([
      'Shift 1',
      'Shift 2',
    ]);
  });

  it('still shows a paper whose exam is missing from the catalogue, last and unnamed', () => {
    const groups = groupPapers(
      [paper({ examId: 'unknown-exam', label: 'Orphan' }), paper({ examId: NET })],
      EXAMS,
    );
    expect(groups.map((g) => g.examId)).toEqual([NET, 'unknown-exam']);
    expect(groups[1].nameEn).toBe('');
  });

  it('gives an empty list for no papers', () => {
    expect(groupPapers([], EXAMS)).toEqual([]);
  });
});
