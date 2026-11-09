/**
 * The one shared read-error state (issue 54a-read-error-core).
 *
 * Definition of done 2: "One shared error component (plain message plus a
 * Retry button) with EN and HI strings. The message names no table, column or
 * key."
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadError } from '../read-error';
import { dictionary } from '@/lib/i18n';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

describe('ReadError', () => {
  it('says what went wrong and the fix, in English by default', () => {
    render(<ReadError />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['read.failed']);
  });

  it('says it in Hindi', () => {
    render(<ReadError mode="hi" />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('names no table, no column and no key', () => {
    // The original bug leaked `archived_at` into a student's screen. Nothing
    // of the database shape belongs in either language.
    for (const text of [dictionary.en['read.failed'], dictionary.hi['read.failed']]) {
      expect(text).not.toMatch(/_|supabase|postgres|column|archived|select|token|key/i);
    }
  });

  it('has a Retry button, and it reloads the server read', () => {
    refresh.mockClear();
    render(<ReadError />);

    const retry = screen.getByRole('button', { name: dictionary.en['read.retry'] });
    fireEvent.click(retry);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('calls an injected onRetry instead, for a client list that holds its own rows', () => {
    refresh.mockClear();
    const onRetry = vi.fn();
    render(<ReadError onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: dictionary.en['read.retry'] }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the Retry button is a real button, 48 px tall (DESIGN.md section 5)', () => {
    render(<ReadError />);

    const retry = screen.getByRole('button', { name: dictionary.en['read.retry'] });
    expect(retry.className).toContain('min-h-12');
  });
});
