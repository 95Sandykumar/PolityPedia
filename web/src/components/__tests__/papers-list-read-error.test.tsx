/**
 * The papers list when the read FAILED (issue 54a-read-error-core).
 *
 * Definition of done 3: "a failed read (HTTP error or thrown error) shows the
 * error state and never the empty-state text. A read that succeeds with zero
 * rows still shows the empty-state text."
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PapersList } from '../papers-list';
import type { Exam } from '@/lib/exams/types';
import type { Paper } from '@/lib/papers/types';
import { dictionary } from '@/lib/i18n';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const NET = 'a4000001-0000-4000-8000-000000000001';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const en = dictionary.en;

const EXAMS: Exam[] = [
  {
    id: NET,
    code: 'ugc-net',
    nameEn: 'UGC NET Political Science',
    nameHi: 'यूजीसी नेट राजनीति विज्ञान',
    marksCorrect: null,
    marksWrong: null,
    durationMin: null,
    questionCount: null,
    markingUnverified: false,
  },
];

const PAPERS: Paper[] = [
  {
    id: 'p1',
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: 6,
    label: 'Shift 1',
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'live',
  },
];

describe('a read that succeeded with zero rows', () => {
  it('still shows the friendly empty state', () => {
    render(<PapersList papers={[]} exams={EXAMS} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['papers.none']);
  });
});

describe('a read that FAILED', () => {
  it('shows the error state', () => {
    render(<PapersList papers={[]} exams={EXAMS} failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', () => {
    render(<PapersList papers={[]} exams={EXAMS} failed />);

    expect(screen.queryByText(en['papers.none'])).not.toBeInTheDocument();
  });

  it('offers Retry, and Retry re-runs the server read', () => {
    refresh.mockClear();
    render(<PapersList papers={[]} exams={EXAMS} failed />);

    fireEvent.click(screen.getByRole('button', { name: en['read.retry'] }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the error state in Hindi too', () => {
    render(<PapersList papers={[]} exams={EXAMS} failed mode="hi" />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('beats the rows: a part-read list is never shown as if it were whole', () => {
    render(<PapersList papers={PAPERS} exams={EXAMS} failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.queryByText('Shift 1')).not.toBeInTheDocument();
  });
});
