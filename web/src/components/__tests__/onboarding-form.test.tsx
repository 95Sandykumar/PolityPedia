/**
 * Issue 04-exams-onboarding: the first sign-in screen.
 *
 * The form takes a BrowserExamsClient, so the test injects a fake: no real
 * network call and no real key (web/CLAUDE.md). This is the test the issue
 * asks for: the screen saves 2 exams + `hi` through the data interface.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingForm } from '../onboarding-form';
import type { BrowserExamsClient, Exam } from '@/lib/exams/types';

function exam(id: string, code: string, nameEn: string, nameHi: string): Exam {
  return {
    id,
    code,
    nameEn,
    nameHi,
    marksCorrect: null,
    marksWrong: null,
    durationMin: null,
    questionCount: null,
    markingUnverified: false,
  };
}

const EXAMS: Exam[] = [
  exam('e1', 'ugc_net_pol_sci', 'UGC NET Political Science', 'यूजीसी नेट राजनीति विज्ञान'),
  exam('e2', 'cuet_pg_pol_sci_huqp18', 'CUET PG Political Science', 'सीयूईटी पीजी राजनीति विज्ञान'),
  exam('e3', 'pgt_pol_sci', 'PGT Political Science', 'पीजीटी राजनीति विज्ञान'),
];

function fakeClient(overrides: Partial<BrowserExamsClient> = {}): BrowserExamsClient {
  return {
    saveOnboarding: vi.fn(async () => {}),
    saveLang: vi.fn(async () => {}),
    ...overrides,
  };
}

const chip = (name: string) => screen.getByRole('button', { name });
const continueButton = () => screen.getByRole('button', { name: 'Continue' });
const langChoice = (name: string) => screen.getByRole('radio', { name });

describe('OnboardingForm', () => {
  it('lists every exam as a chip', () => {
    render(<OnboardingForm exams={EXAMS} client={fakeClient()} />);
    for (const e of EXAMS) {
      expect(chip(e.nameEn)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('offers exactly the three language choices, English first', () => {
    render(<OnboardingForm exams={EXAMS} client={fakeClient()} />);
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual([
      'en',
      'hi',
      'both',
    ]);
    expect(langChoice('English')).toBeChecked();
  });

  it('keeps Continue off until at least one exam is picked', () => {
    render(<OnboardingForm exams={EXAMS} client={fakeClient()} />);
    expect(continueButton()).toBeDisabled();

    fireEvent.click(chip('PGT Political Science'));
    expect(continueButton()).toBeEnabled();
  });

  it('saves two exams and Hindi through the data interface', async () => {
    const client = fakeClient();
    render(<OnboardingForm exams={EXAMS} client={client} onDone={() => {}} />);

    fireEvent.click(chip('UGC NET Political Science'));
    fireEvent.click(chip('PGT Political Science'));
    fireEvent.click(langChoice('Hindi'));
    fireEvent.click(continueButton());

    await waitFor(() =>
      expect(client.saveOnboarding).toHaveBeenCalledWith({ examIds: ['e1', 'e3'], lang: 'hi' }),
    );
    expect(client.saveOnboarding).toHaveBeenCalledTimes(1);
  });

  it('toggles a chip off again', async () => {
    const client = fakeClient();
    render(<OnboardingForm exams={EXAMS} client={client} onDone={() => {}} />);

    fireEvent.click(chip('UGC NET Political Science'));
    fireEvent.click(chip('CUET PG Political Science'));
    fireEvent.click(chip('UGC NET Political Science'));
    expect(chip('UGC NET Political Science')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(client.saveOnboarding).toHaveBeenCalledWith({ examIds: ['e2'], lang: 'en' }),
    );
  });

  it('calls onDone after a save that worked', async () => {
    const onDone = vi.fn();
    render(<OnboardingForm exams={EXAMS} client={fakeClient()} onDone={onDone} />);

    fireEvent.click(chip('PGT Political Science'));
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('shows a fixed message and stays put when the save fails', async () => {
    const client = fakeClient({
      saveOnboarding: vi.fn(async () => {
        throw new Error('supabase said 500');
      }),
    });
    const onDone = vi.fn();
    render(<OnboardingForm exams={EXAMS} client={client} onDone={onDone} />);

    fireEvent.click(chip('PGT Political Science'));
    fireEvent.click(continueButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save. Try again.');
    expect(alert).not.toHaveTextContent(/supabase/i);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows Hindi labels in Hindi mode', () => {
    render(<OnboardingForm exams={EXAMS} client={fakeClient()} mode="hi" />);
    expect(screen.getByRole('button', { name: 'यूजीसी नेट राजनीति विज्ञान' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'जारी रखें' })).toBeInTheDocument();
  });

  it('says so and saves nothing when Supabase is not configured', () => {
    const client = fakeClient();
    render(<OnboardingForm exams={[]} client={client} configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Set up is not ready yet');
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(client.saveOnboarding).not.toHaveBeenCalled();
  });
});
