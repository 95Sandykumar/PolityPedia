/**
 * Issue 05-teacher-invite-approval: the invite-code screen.
 *
 * Definition of done, first half: "a teacher with an invite code signs up and
 * waits as pending". The form takes a client, so the test injects a fake: no
 * real network call and no real key.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherSignupForm } from '../teacher-signup-form';
import type { TeacherSignupClient } from '@/lib/teachers/types';
import { dictionary } from '@/lib/i18n';

function fakeClient(overrides: Partial<TeacherSignupClient> = {}): TeacherSignupClient {
  return { redeem: vi.fn(async () => {}), ...overrides };
}

const codeField = () => screen.getByRole('textbox', { name: 'Invite code' });
const submit = () => screen.getByRole('button', { name: 'Join as a teacher' });

describe('TeacherSignupForm', () => {
  it('spends the code and says the account is waiting for an admin', async () => {
    const client = fakeClient();
    render(<TeacherSignupForm client={client} />);

    fireEvent.change(codeField(), { target: { value: 'INVITE-ONE' } });
    fireEvent.click(submit());

    await waitFor(() => expect(client.redeem).toHaveBeenCalledWith('INVITE-ONE'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      dictionary.en['teacherSignup.done'],
    );
  });

  it('does nothing when the field is empty', () => {
    const client = fakeClient();
    render(<TeacherSignupForm client={client} />);

    fireEvent.click(submit());
    expect(client.redeem).not.toHaveBeenCalled();
  });

  it('shows one fixed message when the code is used or unknown', async () => {
    const client = fakeClient({
      redeem: vi.fn(async () => {
        throw new Error('400 invite code is not valid (teacher_invites)');
      }),
    });
    render(<TeacherSignupForm client={client} />);

    fireEvent.change(codeField(), { target: { value: 'USED-CODE' } });
    fireEvent.click(submit());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(dictionary.en['teacherSignup.failed']);
    // A Postgres or table name must never reach the page.
    expect(alert.textContent).not.toContain('teacher_invites');
  });

  it('hides the form and says so when Supabase is not set up', () => {
    render(<TeacherSignupForm client={fakeClient()} configured={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      dictionary.en['teacherSignup.notConfigured'],
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the Hindi label in Hindi mode', () => {
    render(<TeacherSignupForm client={fakeClient()} mode="hi" />);
    expect(
      screen.getByRole('textbox', { name: dictionary.hi['teacherSignup.code'] }),
    ).toBeInTheDocument();
  });
});
