/**
 * Issue 19-batches: the student's join screen.
 *
 * V2: "Student joins by link or code". The link lands on `/join/<code>` with
 * the field already filled, and a student who was handed the code by voice
 * types it into the same field. One screen, two ways in.
 *
 * The client is a prop, so the test injects a fake: no real network call and
 * no key in any test (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JoinBatch } from '../join-batch';
import type { BrowserBatchesClient } from '@/lib/batches/types';

const BATCH = '33333333-3333-4333-8333-333333333333';

function fakeClient(overrides: Partial<BrowserBatchesClient> = {}): BrowserBatchesClient {
  return {
    saveBatch: vi.fn(async () => {
      throw new Error('not used here');
    }),
    removeMember: vi.fn(async () => {}),
    setFree: vi.fn(async () => {}),
    join: vi.fn(async () => BATCH),
    ...overrides,
  };
}

const codeField = () => screen.getByRole('textbox', { name: 'Join code' });
const joinButton = () => screen.getByRole('button', { name: 'Join' });

function type(value: string) {
  fireEvent.change(codeField(), { target: { value } });
}

describe('JoinBatch', () => {
  it('fills the field from the link, so the student just taps Join', () => {
    render(<JoinBatch code="ABC234" />);
    expect(codeField()).toHaveValue('ABC234');
  });

  it('joins with the code from the link', async () => {
    const client = fakeClient();
    render(<JoinBatch code="ABC234" client={client} />);

    fireEvent.click(joinButton());

    await waitFor(() => {
      expect(client.join).toHaveBeenCalledWith('ABC234');
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'You are in. This batch free sets are open now.',
    );
  });

  it('joins with a code typed in lower case', async () => {
    const client = fakeClient();
    render(<JoinBatch code="" client={client} />);

    type('abc234');
    fireEvent.click(joinButton());

    await waitFor(() => {
      // Normalised before it travels, so the student never has to shout.
      expect(client.join).toHaveBeenCalledWith('ABC234');
    });
  });

  it('shows ONE clear line for a code nobody has, and no server message', async () => {
    const client = fakeClient({
      join: vi.fn(async () => {
        throw new Error('bad-code');
      }),
    });
    render(<JoinBatch code="ZZZZZZ" client={client} />);

    fireEvent.click(joinButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That join code is not right. Check it and try again.');
    expect(alert).not.toHaveTextContent('join_batch');
  });

  it('refuses a code with an ambiguous character before any request', async () => {
    const client = fakeClient();
    render(<JoinBatch code="" client={client} />);

    // O and 0 are not in the alphabet the generator uses, so this was
    // mistyped. Saying so beats a round trip.
    type('ABCO23');
    fireEvent.click(joinButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('That join code is not right');
    expect(client.join).not.toHaveBeenCalled();
  });

  it('shows the generic line for anything else', async () => {
    const client = fakeClient({
      join: vi.fn(async () => {
        throw new Error('Request failed with status 502');
      }),
    });
    render(<JoinBatch code="ABC234" client={client} />);

    fireEvent.click(joinButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not join. Try again.');
    expect(alert).not.toHaveTextContent('502');
  });

  it('renders the not configured line instead of a dead button', () => {
    render(<JoinBatch code="ABC234" configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Joining a batch is not set up yet');
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
  });

  it('writes both languages in both mode', () => {
    render(<JoinBatch code="ABC234" mode="both" />);
    expect(screen.getByRole('heading').textContent).toContain('बैच से जुड़ें');
  });
});
