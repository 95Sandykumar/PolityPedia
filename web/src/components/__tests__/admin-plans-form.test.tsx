/**
 * Issue 21-plans-entitlements: the admin screen that gives a student a plan.
 *
 * This is the "definition of done" test: an admin can give a student the AI
 * plan or Pro for testing, and can end it again. The form takes a client, so
 * the test injects a fake: no real network call and no real key.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPlansForm } from '../admin-plans-form';
import type { AdminPlansClient } from '@/lib/plans/types';

const STUDENT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-05T10:00:00.000Z');
const DAY_MS = 86_400_000;

function fakeClient(overrides: Partial<AdminPlansClient> = {}): AdminPlansClient {
  return {
    grant: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    ...overrides,
  };
}

const userField = () => screen.getByRole('textbox', { name: 'Student user ID' });
const planField = () => screen.getByRole('combobox', { name: 'Plan' });
const daysField = () => screen.getByRole('spinbutton', { name: 'Days' });
const grantButton = () => screen.getByRole('button', { name: 'Grant plan' });
const endButton = () => screen.getByRole('button', { name: 'End plan' });

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

beforeEach(() => {
  // Fake the CLOCK only. Faking setTimeout too would freeze the timers that
  // `waitFor` and `findBy*` run on, and every async assertion would hang.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdminPlansForm', () => {
  it('grants the AI plan with a valid_until the chosen number of days ahead', async () => {
    const client = fakeClient();
    render(<AdminPlansForm client={client} />);

    type(userField(), STUDENT);
    type(daysField(), '30');
    fireEvent.click(grantButton());

    await waitFor(() =>
      expect(client.grant).toHaveBeenCalledWith({
        userId: STUDENT,
        plan: 'ai',
        validUntil: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
      }),
    );
  });

  it('grants Pro when Pro is picked', async () => {
    const client = fakeClient();
    render(<AdminPlansForm client={client} />);

    type(userField(), STUDENT);
    type(planField(), 'pro');
    fireEvent.click(grantButton());

    await waitFor(() =>
      expect(client.grant).toHaveBeenCalledWith(expect.objectContaining({ plan: 'pro' })),
    );
  });

  it('offers exactly the two V18 plans, priced Rs 100 and Rs 500', () => {
    render(<AdminPlansForm client={fakeClient()} />);
    const options = screen.getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['ai', 'pro']);
    expect(options[0].textContent).toMatch(/100/);
    expect(options[1].textContent).toMatch(/500/);
  });

  it('shows a confirmation after a grant', async () => {
    render(<AdminPlansForm client={fakeClient()} />);
    type(userField(), STUDENT);
    fireEvent.click(grantButton());
    expect(await screen.findByRole('status')).toHaveTextContent(/granted/i);
  });

  it('ends a plan for the typed student', async () => {
    const client = fakeClient();
    render(<AdminPlansForm client={client} />);

    type(userField(), STUDENT);
    type(planField(), 'pro');
    fireEvent.click(endButton());

    await waitFor(() => expect(client.end).toHaveBeenCalledWith({ userId: STUDENT, plan: 'pro' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/ended/i);
  });

  it('does nothing with an empty user ID', () => {
    const client = fakeClient();
    render(<AdminPlansForm client={client} />);

    fireEvent.click(grantButton());
    fireEvent.click(endButton());

    expect(client.grant).not.toHaveBeenCalled();
    expect(client.end).not.toHaveBeenCalled();
  });

  it('shows one fixed message when the save fails, never the thrown text', async () => {
    const client = fakeClient({
      grant: vi.fn(async () => {
        throw new Error('403 from postgres: policy entitlements_admin_all');
      }),
    });
    render(<AdminPlansForm client={client} />);

    type(userField(), STUDENT);
    fireEvent.click(grantButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not save/i);
    expect(alert).not.toHaveTextContent(/entitlements_admin_all/);
  });

  it('says so and hides the form when Supabase is not set up', () => {
    render(<AdminPlansForm client={fakeClient()} configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/not set up/i);
    expect(screen.queryByRole('button', { name: 'Grant plan' })).toBeNull();
  });

  it('has every label in Hindi too', () => {
    render(<AdminPlansForm client={fakeClient()} mode="hi" />);
    expect(screen.getByRole('button', { name: 'प्लान दें' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'प्लान बंद करें' })).toBeInTheDocument();
  });
});
