/**
 * The admin payout screen (issue 29-ledger-reconcile-payouts).
 *
 * X1: Boss reads what each teacher is owed for a month, makes the bank
 * transfer by hand, then presses Mark paid. So the screen has to get three
 * things right, and all three are money:
 *
 *  1. The amount shown is the amount in the ledger, to the paisa. A rounded
 *     display is a bank transfer that disagrees with the report forever.
 *  2. A failed read must NOT look like an empty report. "Nothing owed" and
 *     "could not load" are opposite answers.
 *  3. After Mark paid the list is RE-READ from the database, not patched from
 *     an assumption about what the press did.
 *
 * The client is faked, so there is no network call and no key
 * (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminPayoutsForm } from '../admin-payouts-form';
import type { BrowserPayoutsClient, MarkPaidInput, PayoutLine } from '@/lib/ledger/types';

const TEACHER = '3f2cfcdb-ed8e-4612-957d-aad14453f863';
const OTHER = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PAYOUT = 'aa11bb22-cc33-4d44-8e55-ff6677889900';

const LINE: PayoutLine = { teacherId: TEACHER, period: '2026-10', saleCount: 2, amountInr: 330.16 };

interface Fake {
  client: BrowserPayoutsClient;
  marked: MarkPaidInput[];
  reads: number;
}

function fake(
  options: {
    lines?: readonly PayoutLine[];
    /** What the list looks like on every read AFTER the first. */
    after?: readonly PayoutLine[];
    listThrows?: boolean;
    markThrows?: boolean;
    payoutId?: string | null;
  } = {},
): Fake {
  const state: Fake = {
    marked: [],
    reads: 0,
    client: {
      async list() {
        state.reads += 1;
        if (options.listThrows) throw new Error('500');
        if (state.reads > 1 && options.after) return [...options.after];
        return [...(options.lines ?? [LINE])];
      },
      async markPaid(input) {
        state.marked.push(input);
        if (options.markThrows) throw new Error('policy refused');
        return { payoutId: options.payoutId === undefined ? PAYOUT : options.payoutId };
      },
    },
  };
  return state;
}

/** The summary strip repeats the total and the sale count, so read the table. */
async function inTable() {
  return within(await screen.findByRole('table'));
}

describe('the report', () => {
  it('shows the month, the teacher, the sale count and the amount to the paisa', async () => {
    render(<AdminPayoutsForm client={fake().client} />);

    expect((await inTable()).getByText('Rs 330.16')).toBeTruthy();
    expect(screen.getByText('2026-10')).toBeTruthy();
    expect(screen.getByText(TEACHER)).toBeTruthy();
    expect((await inTable()).getByText('2')).toBeTruthy();
  });

  it('writes a whole-rupee amount with its paise, so it matches the ledger column', async () => {
    const line: PayoutLine = { ...LINE, amountInr: 165 };
    render(<AdminPayoutsForm client={fake({ lines: [line] }).client} />);

    expect((await inTable()).getByText('Rs 165.00')).toBeTruthy();
  });

  it('uses the rupee sign in Hindi', async () => {
    render(<AdminPayoutsForm client={fake().client} mode="hi" />);

    expect((await inTable()).getByText('₹330.16')).toBeTruthy();
  });

  it('says so when nothing is owed', async () => {
    render(<AdminPayoutsForm client={fake({ lines: [] }).client} />);

    expect(await screen.findByText('Nothing owed. Every sale is paid out.')).toBeTruthy();
  });

  it('shows one line per teacher per month, because that is one transfer', async () => {
    const lines: PayoutLine[] = [
      LINE,
      { teacherId: TEACHER, period: '2026-09', saleCount: 1, amountInr: 165.08 },
      { teacherId: OTHER, period: '2026-10', saleCount: 3, amountInr: 495.24 },
    ];
    render(<AdminPayoutsForm client={fake({ lines }).client} />);

    (await inTable()).getByText('Rs 330.16');
    expect(screen.getAllByRole('button', { name: 'Mark paid' })).toHaveLength(3);
  });
});

describe('a failed read', () => {
  it('says it could not load, and never shows an empty report instead', async () => {
    render(<AdminPayoutsForm client={fake({ listThrows: true }).client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the report. Reload the page.',
    );
    expect(screen.queryByText('Nothing owed. Every sale is paid out.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark paid' })).toBeNull();
  });
});

describe('Mark paid', () => {
  it('sends the teacher, the month and the typed bank reference', async () => {
    const state = fake({ after: [] });
    render(<AdminPayoutsForm client={state.client} />);
    (await inTable()).getByText('Rs 330.16');

    fireEvent.change(screen.getByRole('textbox', { name: 'Bank reference' }), {
      target: { value: 'UTR123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));

    await waitFor(() => expect(state.marked).toHaveLength(1));
    expect(state.marked[0]).toEqual({
      teacherId: TEACHER,
      period: '2026-10',
      reference: 'UTR123',
    });
  });

  it('sends null when no reference was typed', async () => {
    const state = fake({ after: [] });
    render(<AdminPayoutsForm client={state.client} />);
    (await inTable()).getByText('Rs 330.16');

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));

    await waitFor(() => expect(state.marked).toHaveLength(1));
    expect(state.marked[0].reference).toBeNull();
  });

  it('re-reads the report, so the paid line leaves the list from the database', async () => {
    const state = fake({ after: [] });
    render(<AdminPayoutsForm client={state.client} />);
    (await inTable()).getByText('Rs 330.16');

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));

    expect(await screen.findByText('Payout recorded')).toBeTruthy();
    await waitFor(() => expect(state.reads).toBe(2));
    expect(screen.queryByText('Rs 330.16')).toBeNull();
  });

  it('says "nothing was owed" instead of claiming a payout, when Postgres answers null', async () => {
    const state = fake({ payoutId: null, after: [] });
    render(<AdminPayoutsForm client={state.client} />);
    (await inTable()).getByText('Rs 330.16');

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));

    expect(await screen.findByText('Nothing was owed for that month')).toBeTruthy();
    expect(screen.queryByText('Payout recorded')).toBeNull();
  });

  it('shows one fixed message on a failure, so no policy name reaches the page', async () => {
    const state = fake({ markThrows: true });
    render(<AdminPayoutsForm client={state.client} />);
    (await inTable()).getByText('Rs 330.16');

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save. Try again.');
    expect(screen.queryByText(/policy/i)).toBeNull();
  });

  it('cannot be pressed twice at once: a double click is not a double payout', async () => {
    let release: () => void = () => undefined;
    const marked: MarkPaidInput[] = [];
    const client: BrowserPayoutsClient = {
      async list() {
        return [LINE];
      },
      async markPaid(input) {
        marked.push(input);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { payoutId: PAYOUT };
      },
    };

    render(<AdminPayoutsForm client={client} />);
    (await inTable()).getByText('Rs 330.16');

    const button = screen.getByRole('button', { name: 'Mark paid' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', true));
    // The button is disabled while the first call is in flight, so a second
    // press cannot reach Postgres. (The database would also answer NULL, but
    // the screen must not ask twice in the first place.)
    expect(marked).toHaveLength(1);
    release();
  });
});

describe('not configured', () => {
  it('says so and never calls the client', async () => {
    const state = fake();
    render(<AdminPayoutsForm client={state.client} configured={false} />);

    expect(screen.getByText('Payouts are not set up yet')).toBeTruthy();
    await vi.waitFor(() => expect(state.reads).toBe(0));
  });
});
