/**
 * The Saved tab when the read FAILED
 * (issue 54c-read-errors-saved-practice-media).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * The chips go with the list. A filter above an error state would offer to
 * narrow nothing, and the counts on it would be counts of rows nobody read.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SavedList } from '../saved-list';
import { dictionary } from '@/lib/i18n';
import type { SavedItem } from '@/lib/saved/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const en = dictionary.en;
const TEACHER = '44444444-4444-4444-8444-444444444444';

const ITEMS: SavedItem[] = [
  {
    questionId: '33333333-3333-4333-8333-333333333333',
    tag: 'wrong',
    createdAt: '2026-01-01T00:00:00Z',
    teacherId: TEACHER,
    paperId: null,
    number: 7,
    stem: 'Who presides over the Rajya Sabha?',
  },
];

describe('a read that succeeded with zero rows', () => {
  it('still shows the friendly empty state', () => {
    render(<SavedList items={[]} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['saved.none']);
  });
});

describe('a read that FAILED', () => {
  it('shows the error state', () => {
    render(<SavedList items={[]} failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', () => {
    render(<SavedList items={[]} failed />);

    expect(screen.queryByText(en['saved.none'])).not.toBeInTheDocument();
  });

  it('offers Retry, and Retry re-runs the server read', () => {
    refresh.mockClear();
    render(<SavedList items={[]} failed />);

    fireEvent.click(screen.getByRole('button', { name: en['read.retry'] }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the error state in Hindi too', () => {
    render(<SavedList items={[]} failed mode="hi" />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('beats the rows: a part-read list is never shown as if it were whole', () => {
    render(<SavedList items={ITEMS} failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.queryByText('Who presides over the Rajya Sabha?')).not.toBeInTheDocument();
  });

  it('hides the two filter chips, which would narrow rows nobody read', () => {
    render(<SavedList items={ITEMS} failed />);

    expect(screen.queryAllByTestId('saved-chip')).toHaveLength(0);
  });

  it('names no table, column, key or status', () => {
    render(<SavedList items={[]} failed />);

    const text = screen.getByRole('status').textContent ?? '';
    for (const leak of ['saved_questions', 'question_id', 'column', '400', '500']) {
      expect(text).not.toContain(leak);
    }
  });
});
