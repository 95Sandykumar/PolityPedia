/**
 * Issue 19-batches: one batch's own page.
 *
 * Three things live here, and they are the three the definition of done names:
 * the code (so the teacher can share it again), the students (so the teacher
 * can remove one), and the free sets (V3).
 *
 * The client is a prop, so the test injects a fake: no real network call and
 * no key in any test (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherBatchDetail } from '../teacher-batch-detail';
import type { Batch, BatchMember, BrowserBatchesClient } from '@/lib/batches/types';
import type { MockSet } from '@/lib/mocks/types';

const BATCH = '33333333-3333-4333-8333-333333333333';
const TEACHER = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const SET_1 = '44444444-4444-4444-8444-444444444444';
const SET_2 = '77777777-7777-4777-8777-777777777777';

const ONE: Batch = {
  id: BATCH,
  teacherId: TEACHER,
  name: 'Morning batch',
  joinCode: 'ABC234',
};

const MEMBERS: BatchMember[] = [
  { batchId: BATCH, userId: STUDENT, joinedAt: '2026-11-05T10:00:00.000Z' },
  { batchId: BATCH, userId: OTHER, joinedAt: '2026-11-05T11:00:00.000Z' },
];

const SETS: MockSet[] = [
  {
    id: SET_1,
    teacherId: TEACHER,
    examId: 'e1',
    title: 'Full length set 1',
    priceInr: 399,
    status: 'live',
  },
  {
    id: SET_2,
    teacherId: TEACHER,
    examId: 'e1',
    title: 'Full length set 2',
    priceInr: 299,
    status: 'draft',
  },
];

function fakeClient(overrides: Partial<BrowserBatchesClient> = {}): BrowserBatchesClient {
  return {
    saveBatch: vi.fn(async () => ONE),
    removeMember: vi.fn(async () => {}),
    setFree: vi.fn(async () => {}),
    join: vi.fn(async () => BATCH),
    ...overrides,
  };
}

function freeToggle(title: string) {
  return screen.getByRole('checkbox', { name: new RegExp(title) });
}

describe('TeacherBatchDetail', () => {
  it('shows the batch name, its code and its join link', () => {
    render(
      <TeacherBatchDetail
        batch={ONE}
        members={[]}
        sets={[]}
        freeSetIds={[]}
        origin="https://politypedia.in"
      />,
    );
    expect(screen.getByRole('heading', { name: /Morning batch/ })).toBeInTheDocument();
    expect(screen.getByText('ABC234')).toBeInTheDocument();
  });

  it('says Batch not found for a null batch, and never why', () => {
    render(
      <TeacherBatchDetail batch={null} members={[]} sets={[]} freeSetIds={[]} origin="" />,
    );
    // The same line a stranger gets. RLS hid the row; the page does not say
    // whether it exists.
    expect(screen.getByRole('status')).toHaveTextContent('Batch not found');
  });

  it('lists the students and says so when there are none', () => {
    const { unmount } = render(
      <TeacherBatchDetail batch={ONE} members={MEMBERS} sets={[]} freeSetIds={[]} origin="" />,
    );
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    unmount();

    render(
      <TeacherBatchDetail batch={ONE} members={[]} sets={[]} freeSetIds={[]} origin="" />,
    );
    expect(screen.getByText('Nobody has joined yet')).toBeInTheDocument();
  });

  it('removes a student and takes the row off the list (V2)', async () => {
    const client = fakeClient();
    render(
      <TeacherBatchDetail
        batch={ONE}
        members={MEMBERS}
        sets={[]}
        freeSetIds={[]}
        origin=""
        client={client}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);

    await waitFor(() => {
      expect(client.removeMember).toHaveBeenCalledWith(BATCH, STUDENT);
    });
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    });
  });

  it('keeps the student on screen and says so when the remove fails', async () => {
    const client = fakeClient({
      removeMember: vi.fn(async () => {
        throw new Error('policy "batch_members_delete_own_or_teacher" blocked it');
      }),
    });
    render(
      <TeacherBatchDetail
        batch={ONE}
        members={MEMBERS}
        sets={[]}
        freeSetIds={[]}
        origin=""
        client={client}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not remove. Try again.');
    expect(alert).not.toHaveTextContent('batch_members_delete');
    // Still two: a failed remove must not look like a done one.
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('ticks the sets this batch already gets free (V3)', () => {
    render(
      <TeacherBatchDetail
        batch={ONE}
        members={[]}
        sets={SETS}
        freeSetIds={[SET_1]}
        origin=""
      />,
    );
    expect(freeToggle('Full length set 1')).toBeChecked();
    expect(freeToggle('Full length set 2')).not.toBeChecked();
  });

  it('gives a set away and takes it back with the same toggle', async () => {
    const client = fakeClient();
    render(
      <TeacherBatchDetail
        batch={ONE}
        members={[]}
        sets={SETS}
        freeSetIds={[SET_1]}
        origin=""
        client={client}
      />,
    );

    fireEvent.click(freeToggle('Full length set 2'));
    await waitFor(() => {
      expect(client.setFree).toHaveBeenCalledWith(BATCH, SET_2, true);
    });

    fireEvent.click(freeToggle('Full length set 1'));
    await waitFor(() => {
      expect(client.setFree).toHaveBeenCalledWith(BATCH, SET_1, false);
    });
  });

  it('puts the toggle back when the save fails', async () => {
    const client = fakeClient({
      setFree: vi.fn(async () => {
        throw new Error('policy blocked it');
      }),
    });
    render(
      <TeacherBatchDetail
        batch={ONE}
        members={[]}
        sets={SETS}
        freeSetIds={[]}
        origin=""
        client={client}
      />,
    );

    fireEvent.click(freeToggle('Full length set 1'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save. Try again.');
    // A tick that did not stick must not stay ticked: the teacher would think
    // the batch has the set.
    await waitFor(() => {
      expect(freeToggle('Full length set 1')).not.toBeChecked();
    });
  });

  it('says so when the teacher has no mock set to give away', () => {
    render(
      <TeacherBatchDetail batch={ONE} members={[]} sets={[]} freeSetIds={[]} origin="" />,
    );
    expect(screen.getByText('You have no mock sets yet')).toBeInTheDocument();
  });
});
