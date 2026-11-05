/**
 * The Saved tab (issue 14-saved-list).
 *
 * Definition of done: "The Saved tab shows both with two filter chips and
 * opens a question in the player." F-E8: ONE list, TWO tags.
 *
 * The client is a FAKE, so no test makes a network call and no test holds a
 * key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SavedList } from '../saved-list';
import { dictionary } from '@/lib/i18n';
import type { BrowserSavedClient, SavedItem } from '@/lib/saved/types';

const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';
const Q1 = '22222222-2222-4222-8222-222222222221';
const Q2 = '22222222-2222-4222-8222-222222222222';

function item(values: Partial<SavedItem> & { questionId: string }): SavedItem {
  return {
    tag: 'wrong',
    createdAt: '2026-11-05T10:00:00.000Z',
    teacherId: TEACHER,
    paperId: PAPER,
    number: 1,
    stem: 'Which house is the Council of States?',
    ...values,
  };
}

const WRONG = item({ questionId: Q1, tag: 'wrong', number: 7 });
const MARKED = item({
  questionId: Q2,
  tag: 'marked',
  number: 12,
  stem: 'Which list carries police?',
});

function fakeClient(): BrowserSavedClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    setSaved: vi.fn(async (questionId: string, tag: string, saved: boolean) => {
      calls.push({ questionId, tag, saved });
    }),
  } as BrowserSavedClient & { calls: unknown[] };
}

function setup(items: readonly SavedItem[] = [WRONG, MARKED]) {
  const client = fakeClient();
  const view = render(<SavedList items={items} client={client} />);
  return { client, view };
}

function rows(): HTMLElement[] {
  return screen.getAllByTestId('saved-row');
}

function chip(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(name, 'i') });
}

describe('SavedList: both tags', () => {
  it('shows the wrong and the marked question in one list', () => {
    setup();

    expect(rows()).toHaveLength(2);
    expect(screen.getByText(WRONG.stem)).toBeInTheDocument();
    expect(screen.getByText(MARKED.stem)).toBeInTheDocument();
  });

  it('labels each row with its tag as a word, never colour alone', () => {
    setup();

    const tags = rows().map((row) => row.getAttribute('data-tag'));
    expect(tags).toEqual(['wrong', 'marked']);
    // The word is IN the row, next to the icon, not only in the chip above.
    expect(within(rows()[0]).getByText(dictionary.en['saved.wrong'])).toBeInTheDocument();
    expect(within(rows()[1]).getByText(dictionary.en['saved.marked'])).toBeInTheDocument();
  });

  it('opens the question in the player', () => {
    setup([WRONG]);

    const link = screen.getByRole('link', {
      name: new RegExp(dictionary.en['player.title'], 'i'),
    });
    expect(link).toHaveAttribute('href', `/t/${TEACHER}/papers/${PAPER}/play`);
  });

  it('says so when nothing is saved yet', () => {
    setup([]);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['saved.none']);
    expect(screen.queryAllByTestId('saved-row')).toHaveLength(0);
  });
});

describe('SavedList: the two filter chips', () => {
  it('narrows the list to one tag, and clears on a second tap', () => {
    setup();

    fireEvent.click(chip(dictionary.en['saved.wrong']));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveAttribute('data-tag', 'wrong');
    expect(chip(dictionary.en['saved.wrong'])).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(chip(dictionary.en['saved.marked']));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveAttribute('data-tag', 'marked');

    // Tapping the chip that is on clears the filter, so both come back.
    fireEvent.click(chip(dictionary.en['saved.marked']));
    expect(rows()).toHaveLength(2);
    expect(chip(dictionary.en['saved.marked'])).toHaveAttribute('aria-pressed', 'false');
  });

  it('counts each tag on its chip', () => {
    setup([WRONG, MARKED, item({ questionId: Q2, tag: 'wrong', number: 12 })]);

    expect(chip(dictionary.en['saved.wrong'])).toHaveTextContent('2');
    expect(chip(dictionary.en['saved.marked'])).toHaveTextContent('1');
  });
});

describe('SavedList: Remove', () => {
  it('drops the row and tells the server which tag went', async () => {
    const { client } = setup();

    fireEvent.click(screen.getAllByTestId('saved-remove')[0]);

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(client.setSaved).toHaveBeenCalledWith(Q1, 'wrong', false);
    // The other tag of the same question is untouched.
    expect(rows()[0]).toHaveAttribute('data-tag', 'marked');
  });

  it('puts the row back and says so when the server refuses', async () => {
    const client = fakeClient();
    client.setSaved = vi.fn(async () => {
      throw new Error('Request failed with status 502');
    });
    render(<SavedList items={[WRONG]} client={client} />);

    fireEvent.click(screen.getAllByTestId('saved-remove')[0]);

    await waitFor(() =>
      expect(screen.getByTestId('saved-failed')).toHaveTextContent(
        dictionary.en['saved.failed'],
      ),
    );
    expect(rows()).toHaveLength(1);
  });
});

describe('SavedList: Hindi', () => {
  it('draws the chips in Hindi', () => {
    render(<SavedList items={[WRONG, MARKED]} client={fakeClient()} mode="hi" />);

    expect(chip(dictionary.hi['saved.wrong'])).toBeInTheDocument();
    expect(chip(dictionary.hi['saved.marked'])).toBeInTheDocument();
  });
});
