/**
 * Student papers list: question count, Done tick and the hidden Practice link
 * (issue 66-papers-question-count).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PapersList } from '../papers-list';
import type { Exam } from '@/lib/exams/types';
import type { Paper } from '@/lib/papers/types';

const NET = 'a4000001-0000-4000-8000-000000000001';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const EMPTY = 'c0000000-0000-4000-8000-000000000001';
const ONE = 'c0000000-0000-4000-8000-000000000002';
const MANY = 'c0000000-0000-4000-8000-000000000003';

const EXAMS: Exam[] = [
  {
    id: NET,
    code: 'net',
    nameEn: 'UGC NET Political Science',
    nameHi: 'यूजीसी नेट राजनीति विज्ञान',
    marksCorrect: null,
    marksWrong: null,
    durationMin: null,
    questionCount: null,
    markingUnverified: false,
  },
];

function paper(id: string, label: string): Paper {
  return {
    id,
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: 6,
    label,
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'live',
  };
}

const PAPERS = [
  paper(EMPTY, 'Shift Empty'),
  paper(ONE, 'Shift One'),
  paper(MANY, 'Shift Many'),
];

const PROGRESS = new Map([
  [EMPTY, { questionCount: 0, done: false }],
  [ONE, { questionCount: 1, done: true }],
  [MANY, { questionCount: 12, done: false }],
]);

describe('PapersList progress on the student page', () => {
  it('hides the Practice link for a paper with 0 questions and says it is coming soon', () => {
    render(
      <PapersList
        papers={PAPERS}
        exams={EXAMS}
        playTeacherId={TEACHER}
        progress={PROGRESS}
      />,
    );

    expect(
      screen.queryByRole('link', { name: 'Shift Empty: Practice' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Questions coming soon')).toBeInTheDocument();
  });

  it('keeps the Practice link for papers that have questions', () => {
    render(
      <PapersList
        papers={PAPERS}
        exams={EXAMS}
        playTeacherId={TEACHER}
        progress={PROGRESS}
      />,
    );

    expect(screen.getByRole('link', { name: 'Shift One: Practice' })).toHaveAttribute(
      'href',
      expect.stringContaining(ONE),
    );
    expect(screen.getByRole('link', { name: 'Shift Many: Practice' })).toBeInTheDocument();
  });

  it('shows the question count and a Done tick only on the paper with a submitted attempt', () => {
    render(
      <PapersList
        papers={PAPERS}
        exams={EXAMS}
        playTeacherId={TEACHER}
        progress={PROGRESS}
      />,
    );

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getAllByText('Done')).toHaveLength(1);
  });

  it('keeps Practice when no progress is known for a paper', () => {
    render(<PapersList papers={PAPERS} exams={EXAMS} playTeacherId={TEACHER} />);

    expect(screen.getByRole('link', { name: 'Shift Empty: Practice' })).toBeInTheDocument();
    expect(screen.queryByText('Questions coming soon')).not.toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
});
