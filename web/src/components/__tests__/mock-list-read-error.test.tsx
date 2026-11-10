/**
 * The mock list when the read FAILED (issue 54a-read-error-core).
 *
 * This is the bug the ticket exists for: a missing `archived_at` column made
 * the read come back empty, and the list said "No mock tests yet. Your teacher
 * adds them soon." while the sets were there all along.
 *
 * Definition of done 3: "a failed read (HTTP error or thrown error) shows the
 * error state and never the empty-state text. A read that succeeds with zero
 * rows still shows the empty-state text."
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MockList } from '../mock-list';
import { buildMockRows } from '@/lib/set-access/types';
import { dictionary } from '@/lib/i18n';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const TEACHER = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const TEST_1 = '33333333-3333-4333-8333-333333333333';
const en = dictionary.en;

const ROWS = buildMockRows({
  sets: [{ id: SET, title: 'UGC NET Mock Set', priceInr: 399 }],
  tests: [{ id: TEST_1, setId: SET, title: 'Test 1', position: 1, isFreeSample: true }],
  access: [],
  scores: [],
});

describe('a read that succeeded with zero rows', () => {
  it('still shows the friendly empty state', () => {
    render(<MockList sets={[]} teacherId={TEACHER} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['mockList.none']);
  });
});

describe('a read that FAILED', () => {
  it('shows the error state', () => {
    render(<MockList sets={[]} teacherId={TEACHER} failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text, which is the original bug', () => {
    render(<MockList sets={[]} teacherId={TEACHER} failed />);

    expect(screen.queryByText(en['mockList.none'])).not.toBeInTheDocument();
  });

  it('offers Retry, and Retry re-runs the server read', () => {
    refresh.mockClear();
    render(<MockList sets={[]} teacherId={TEACHER} failed />);

    fireEvent.click(screen.getByRole('button', { name: en['read.retry'] }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the error state in Hindi too', () => {
    render(<MockList sets={[]} teacherId={TEACHER} failed mode="hi" />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('beats the rows: a half-read list is never shown as if it were whole', () => {
    // A failure with rows in hand means part of the chain answered and part
    // did not, so the locks, ticks and scores on screen could be wrong. A
    // wrong lock is a set sold twice or a paid set still shut.
    render(<MockList sets={ROWS} teacherId={TEACHER} failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.queryByText('UGC NET Mock Set')).not.toBeInTheDocument();
  });
});
