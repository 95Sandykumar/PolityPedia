/**
 * Student browse: Exam > Year > Month > paper, with a download button
 * (issue 10-papers-upload-browse).
 *
 * Definition of done: "Students browse Exam > Year > Month > paper and
 * download the PDF."
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PapersList } from '../papers-list';
import type { Exam } from '@/lib/exams/types';
import type { Paper } from '@/lib/papers/types';
import { dictionary } from '@/lib/i18n';

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

function paper(values: Partial<Paper> & { id: string }): Paper {
  return {
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: 6,
    label: 'Shift 1',
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'live',
    ...values,
  };
}

describe('PapersList', () => {
  it('shows the empty state when the teacher has no papers', () => {
    render(<PapersList papers={[]} exams={EXAMS} />);
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['papers.none']);
  });

  it('groups the papers by exam, then year, then month', () => {
    render(
      <PapersList
        papers={[
          paper({ id: 'a', year: 2023, month: 6, label: 'Shift 1' }),
          paper({ id: 'b', year: 2025, month: 12, label: 'Shift 1' }),
          paper({ id: 'c', examId: CUET, year: 2024, month: null, label: 'Full paper' }),
        ]}
        exams={EXAMS}
      />,
    );

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual([
      'UGC NET Political Science',
      '2025',
      'Dec',
      '2023',
      'Jun',
      'CUET PG Political Science',
      '2024',
    ]);
  });

  it('gives each PDF its own download link', () => {
    render(
      <PapersList
        papers={[
          paper({
            id: 'a',
            label: 'Shift 1',
            questionsPath: 'papers/q.pdf',
            solutionsPath: 'papers/s.pdf',
          }),
        ]}
        exams={EXAMS}
      />,
    );

    expect(screen.getByRole('link', { name: /Shift 1.*Questions/ })).toHaveAttribute(
      'href',
      '/api/papers/a/download?kind=questions',
    );
    expect(screen.getByRole('link', { name: /Shift 1.*Solutions/ })).toHaveAttribute(
      'href',
      '/api/papers/a/download?kind=solutions',
    );
  });

  it('offers no solutions link when the teacher uploaded questions only', () => {
    render(<PapersList papers={[paper({ id: 'a', solutionsPath: null })]} exams={EXAMS} />);

    expect(screen.getByRole('link', { name: /Questions/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Solutions/ })).toBeNull();
  });

  it('shows no status badge to a student', () => {
    render(<PapersList papers={[paper({ id: 'a' })]} exams={EXAMS} />);
    expect(screen.queryByText(dictionary.en['papers.live'])).toBeNull();
  });

  it('shows Draft and Live to the teacher who owns the papers', () => {
    render(
      <PapersList
        papers={[
          paper({ id: 'a', label: 'One', status: 'draft' }),
          paper({ id: 'b', label: 'Two', status: 'live' }),
        ]}
        exams={EXAMS}
        showStatus
      />,
    );

    expect(screen.getByText(dictionary.en['papers.draft'])).toBeInTheDocument();
    expect(screen.getByText(dictionary.en['papers.live'])).toBeInTheDocument();
  });

  it('shows Hindi labels in Hindi mode', () => {
    render(<PapersList papers={[paper({ id: 'a' })]} exams={EXAMS} mode="hi" />);

    expect(
      screen.getByRole('heading', { name: 'यूजीसी नेट राजनीति विज्ञान' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'जून' })).toBeInTheDocument();
  });
});
