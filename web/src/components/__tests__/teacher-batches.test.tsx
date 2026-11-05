/**
 * Issue 19-batches: the teacher's batch list.
 *
 * V2: "teacher creates many batches ... Student joins by link or code." So the
 * list has to do two jobs: make a batch, and hand over the link in one tap.
 *
 * The client is a prop, so the test injects a fake: no real network call and
 * no key in any test (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherBatches } from '../teacher-batches';
import type { Batch, BatchRow, BrowserBatchesClient } from '@/lib/batches/types';

const BATCH = '33333333-3333-4333-8333-333333333333';
const TEACHER = '11111111-1111-4111-8111-111111111111';

const MADE: Batch = {
  id: '55555555-5555-4555-8555-555555555555',
  teacherId: TEACHER,
  name: 'Evening batch',
  joinCode: 'KLM678',
};

const ROWS: BatchRow[] = [
  { id: BATCH, teacherId: TEACHER, name: 'Morning batch', joinCode: 'ABC234', studentCount: 2 },
];

function fakeClient(overrides: Partial<BrowserBatchesClient> = {}): BrowserBatchesClient {
  return {
    saveBatch: vi.fn(async () => MADE),
    removeMember: vi.fn(async () => {}),
    setFree: vi.fn(async () => {}),
    join: vi.fn(async () => BATCH),
    ...overrides,
  };
}

const nameField = () => screen.getByRole('textbox', { name: 'Batch name' });
const createButton = () => screen.getByRole('button', { name: 'Create batch' });

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

describe('TeacherBatches', () => {
  it('shows each batch with its code and its student count', () => {
    render(<TeacherBatches batches={ROWS} origin="https://politypedia.in" />);
    expect(screen.getByText('Morning batch')).toBeInTheDocument();
    expect(screen.getByText('ABC234')).toBeInTheDocument();
    expect(screen.getByText(/Students/)).toHaveTextContent('2');
  });

  it('says so when there is no batch yet', () => {
    render(<TeacherBatches batches={[]} origin="" />);
    expect(screen.getByRole('status')).toHaveTextContent('No batches yet');
  });

  it('creates a batch and lands it in the list with no reload', async () => {
    const client = fakeClient();
    render(<TeacherBatches batches={ROWS} origin="" client={client} />);

    type(nameField(), '  Evening batch ');
    fireEvent.click(createButton());

    await waitFor(() => {
      expect(client.saveBatch).toHaveBeenCalledWith({ id: null, name: 'Evening batch' });
    });
    // The new row is on screen, code and all, without a page reload.
    expect(await screen.findByText('Evening batch')).toBeInTheDocument();
    expect(screen.getByText('KLM678')).toBeInTheDocument();
  });

  it('refuses a blank name with no request at all', async () => {
    const client = fakeClient();
    render(<TeacherBatches batches={[]} origin="" client={client} />);

    type(nameField(), '   ');
    fireEvent.click(createButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Type a batch name');
    expect(client.saveBatch).not.toHaveBeenCalled();
  });

  it('shows one line and no server message when the save fails', async () => {
    const client = fakeClient({
      saveBatch: vi.fn(async () => {
        throw new Error('policy "batches_insert_own" blocked it');
      }),
    });
    render(<TeacherBatches batches={[]} origin="" client={client} />);

    type(nameField(), 'Evening batch');
    fireEvent.click(createButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save. Try again.');
    expect(alert).not.toHaveTextContent('batches_insert_own');
  });

  it('copies the whole join link, not just the code', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<TeacherBatches batches={ROWS} origin="https://politypedia.in" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy join link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://politypedia.in/join/ABC234');
    });
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('renders the not configured line instead of firing reads', () => {
    render(<TeacherBatches batches={[]} origin="" configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Batches are not set up yet');
    expect(screen.queryByRole('button', { name: 'Create batch' })).toBeNull();
  });

  it('writes both languages in both mode', () => {
    render(<TeacherBatches batches={[]} origin="" mode="both" />);
    expect(screen.getByRole('status').textContent).toContain('अभी कोई बैच नहीं');
  });
});
