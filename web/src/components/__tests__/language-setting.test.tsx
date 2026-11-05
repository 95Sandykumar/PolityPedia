/**
 * Issue 04-exams-onboarding: Me > Language.
 *
 * DESIGN.md D6: this is the ONLY language toggle in the app besides first
 * sign-in. The test the issue asks for: picking a language writes
 * `profiles.lang` through the data interface.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageSetting } from '../language-setting';
import type { BrowserExamsClient } from '@/lib/exams/types';

function fakeClient(overrides: Partial<BrowserExamsClient> = {}): BrowserExamsClient {
  return {
    saveOnboarding: vi.fn(async () => {}),
    saveLang: vi.fn(async () => {}),
    ...overrides,
  };
}

const choice = (name: string) => screen.getByRole('radio', { name });

describe('LanguageSetting', () => {
  it('marks the saved language as the current one', () => {
    render(<LanguageSetting value="both" client={fakeClient()} />);
    expect(choice('Both / दोनों')).toBeChecked();
    expect(choice('English / अंग्रेज़ी')).not.toBeChecked();
  });

  it('saves Hindi to profiles.lang when Hindi is picked', async () => {
    const client = fakeClient();
    render(<LanguageSetting value="en" client={client} />);

    fireEvent.click(choice('Hindi'));

    await waitFor(() => expect(client.saveLang).toHaveBeenCalledWith('hi'));
    expect(client.saveLang).toHaveBeenCalledTimes(1);
    // The screen is now in Hindi, so the labels are too.
    expect(choice('हिंदी')).toBeChecked();
  });

  it('confirms the save', async () => {
    render(<LanguageSetting value="en" client={fakeClient()} />);
    fireEvent.click(choice('Both'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('puts the language back and shows a fixed message when the save fails', async () => {
    const client = fakeClient({
      saveLang: vi.fn(async () => {
        throw new Error('supabase said 500');
      }),
    });
    render(<LanguageSetting value="en" client={client} />);

    fireEvent.click(choice('Hindi'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save. Try again.');
    expect(alert).not.toHaveTextContent(/supabase/i);
    await waitFor(() => expect(choice('English')).toBeChecked());
  });

  it('says so when Supabase is not configured', () => {
    render(<LanguageSetting value="en" client={fakeClient()} configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Set up is not ready yet');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
