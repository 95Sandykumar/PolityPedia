/**
 * Issue 05-teacher-invite-approval: the admin approval screen.
 *
 * Definition of done, second half: "an admin approves them". The list takes a
 * client, so the test injects a fake: no real network call and no real key.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminTeachersList } from '../admin-teachers-list';
import type { AdminTeachersClient, PendingTeacher } from '@/lib/teachers/types';
import { dictionary } from '@/lib/i18n';

const ONE: PendingTeacher = {
  userId: '44444444-4444-4444-8444-444444444444',
  realName: 'Rahul Sharma',
  alias: 'Polity Guru',
  createdAt: '2026-11-05T10:00:00Z',
};

const TWO: PendingTeacher = {
  userId: '55555555-5555-4555-8555-555555555555',
  realName: null,
  alias: 'Newcomer',
  createdAt: '2026-11-05T11:00:00Z',
};

function fakeClient(overrides: Partial<AdminTeachersClient> = {}): AdminTeachersClient {
  return { approve: vi.fn(async () => {}), ...overrides };
}

const approveButtons = () => screen.getAllByRole('button', { name: 'Approve' });

describe('AdminTeachersList', () => {
  it('lists everybody who is waiting, real name and alias', () => {
    render(<AdminTeachersList teachers={[ONE, TWO]} client={fakeClient()} />);

    expect(screen.getByText('Rahul Sharma')).toBeInTheDocument();
    expect(screen.getByText('Polity Guru')).toBeInTheDocument();
    expect(screen.getByText('Newcomer')).toBeInTheDocument();
    expect(approveButtons()).toHaveLength(2);
  });

  it('approves the chosen teacher and takes the row off the list', async () => {
    const client = fakeClient();
    render(<AdminTeachersList teachers={[ONE, TWO]} client={client} />);

    fireEvent.click(approveButtons()[0]);

    await waitFor(() => expect(client.approve).toHaveBeenCalledWith(ONE.userId));
    expect(await screen.findByRole('status')).toHaveTextContent(
      dictionary.en['adminTeachers.approved'],
    );
    await waitFor(() => expect(screen.queryByText('Rahul Sharma')).toBeNull());
    expect(screen.getByText('Newcomer')).toBeInTheDocument();
  });

  it('keeps the row and shows one fixed message when the write fails', async () => {
    const client = fakeClient({
      approve: vi.fn(async () => {
        throw new Error('403 row-level security policy teachers_admin_all');
      }),
    });
    render(<AdminTeachersList teachers={[ONE]} client={client} />);

    fireEvent.click(approveButtons()[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(dictionary.en['adminTeachers.failed']);
    expect(alert.textContent).not.toContain('teachers_admin_all');
    expect(screen.getByText('Rahul Sharma')).toBeInTheDocument();
  });

  it('says nobody is waiting on an empty list', () => {
    render(<AdminTeachersList teachers={[]} client={fakeClient()} />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['adminTeachers.none']);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('says so when Supabase is not set up', () => {
    render(<AdminTeachersList teachers={[]} client={fakeClient()} configured={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      dictionary.en['adminTeachers.notConfigured'],
    );
  });
});
