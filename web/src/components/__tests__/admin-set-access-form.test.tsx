/**
 * Issue 16-set-access-mock-list: the admin screen that opens a mock set for
 * one student.
 *
 * This is the "admin page to grant a set to a student (source admin)" in the
 * vertical slice. The form takes a client, so the test injects a fake: no real
 * network call and no real key.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSetAccessForm } from '../admin-set-access-form';
import type { AdminSetAccessClient } from '@/lib/set-access/types';

const STUDENT = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-05T10:00:00.000Z');
const DAY_MS = 86_400_000;

function fakeClient(overrides: Partial<AdminSetAccessClient> = {}): AdminSetAccessClient {
  return {
    grant: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
}

const userField = () => screen.getByRole('textbox', { name: 'Student user ID' });
const setField = () => screen.getByRole('textbox', { name: 'Mock set ID' });
const daysField = () => screen.getByRole('spinbutton', { name: 'Days' });
const grantButton = () => screen.getByRole('button', { name: 'Open the set' });
const revokeButton = () => screen.getByRole('button', { name: 'Close the set' });

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

function fill() {
  type(userField(), STUDENT);
  type(setField(), SET);
}

beforeEach(() => {
  // Fake the CLOCK only. Faking setTimeout too would freeze the timers that
  // `waitFor` runs on, and every async assertion would hang.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdminSetAccessForm', () => {
  it('grants the set with a valid_until the chosen number of days ahead', async () => {
    const client = fakeClient();
    render(<AdminSetAccessForm client={client} />);

    fill();
    type(daysField(), '30');
    fireEvent.click(grantButton());

    await waitFor(() =>
      expect(client.grant).toHaveBeenCalledWith({
        userId: STUDENT,
        setId: SET,
        validUntil: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Set opened');
  });

  it('clamps a silly number of days, so a typo is not a ten-year grant', async () => {
    const client = fakeClient();
    render(<AdminSetAccessForm client={client} />);

    fill();
    type(daysField(), '99999');
    fireEvent.click(grantButton());

    await waitFor(() =>
      expect(client.grant).toHaveBeenCalledWith({
        userId: STUDENT,
        setId: SET,
        validUntil: new Date(NOW.getTime() + 365 * DAY_MS).toISOString(),
      }),
    );
  });

  it('closes the set again', async () => {
    const client = fakeClient();
    render(<AdminSetAccessForm client={client} />);

    fill();
    fireEvent.click(revokeButton());

    await waitFor(() =>
      expect(client.revoke).toHaveBeenCalledWith({ userId: STUDENT, setId: SET }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Set closed');
  });

  it('does nothing until both ids are filled in', () => {
    const client = fakeClient();
    render(<AdminSetAccessForm client={client} />);

    type(userField(), STUDENT);
    fireEvent.click(grantButton());
    expect(client.grant).not.toHaveBeenCalled();
  });

  it('shows one fixed message when Supabase refuses, never the reason', async () => {
    const client = fakeClient({
      grant: vi.fn(async () => {
        throw new Error('new row violates row-level security policy for "set_access"');
      }),
    });
    render(<AdminSetAccessForm client={client} />);

    fill();
    fireEvent.click(grantButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save. Check both IDs and try again.');
    expect(alert).not.toHaveTextContent('row-level security');
  });

  it('says so when Supabase is not set up, and shows no form', () => {
    render(<AdminSetAccessForm configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Mock set access is not set up yet',
    );
    expect(screen.queryByRole('button', { name: 'Open the set' })).not.toBeInTheDocument();
  });
});
