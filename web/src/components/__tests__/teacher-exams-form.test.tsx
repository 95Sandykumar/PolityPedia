/**
 * Teacher Profile: pick exams, set the next date for each
 * (issue 07-next-exam-date-teacher-shell).
 *
 * Definition of done: "a teacher ... sets the next exam date for each of their
 * exams".
 *
 * The browser client is a prop, so the test injects a fake: no real network
 * call and no real key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherExamsForm } from '../teacher-exams-form';
import { dictionary } from '@/lib/i18n';
import type { Exam } from '@/lib/exams/types';
import type { BrowserTeacherExamsClient } from '@/lib/teacher-exams/types';

const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

const EXAMS: Exam[] = [
  {
    id: NET,
    code: 'ugc_net_pol_sci',
    nameEn: 'UGC NET Political Science',
    nameHi: 'यूजीसी नेट राजनीति विज्ञान',
    marksCorrect: 2,
    marksWrong: 0,
    durationMin: null,
    questionCount: null,
    markingUnverified: true,
  },
  {
    id: CUET,
    code: 'cuet_pg_pol_sci_huqp18',
    nameEn: 'CUET PG Political Science (HUQP18)',
    nameHi: 'सीयूईटी पीजी राजनीति विज्ञान (HUQP18)',
    marksCorrect: 4,
    marksWrong: -1,
    durationMin: 90,
    questionCount: 75,
    markingUnverified: false,
  },
];

function fakeClient(
  overrides: Partial<BrowserTeacherExamsClient> = {},
): BrowserTeacherExamsClient {
  return { save: vi.fn(async () => {}), ...overrides };
}

const chip = (name: string) => screen.getByRole('button', { name });
const saveButton = () => screen.getByRole('button', { name: dictionary.en['teacherProfile.save'] });

describe('TeacherExamsForm', () => {
  it('shows one chip per exam and no date box until an exam is picked', () => {
    render(<TeacherExamsForm exams={EXAMS} items={[]} client={fakeClient()} />);

    expect(chip('UGC NET Political Science')).toHaveAttribute('aria-pressed', 'false');
    expect(chip('CUET PG Political Science (HUQP18)')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText(/Next exam date/)).toBeNull();
  });

  it('opens a date box and a short-name box when an exam is picked', () => {
    render(<TeacherExamsForm exams={EXAMS} items={[]} client={fakeClient()} />);

    fireEvent.click(chip('UGC NET Political Science'));

    expect(chip('UGC NET Political Science')).toHaveAttribute('aria-pressed', 'true');
    const date = screen.getByLabelText('Next exam date: UGC NET Political Science');
    expect(date).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Short name: UGC NET Political Science')).toBeInTheDocument();
  });

  it('sends the picked exam, its date and its short name', async () => {
    const client = fakeClient();
    render(<TeacherExamsForm exams={EXAMS} items={[]} client={client} />);

    fireEvent.click(chip('UGC NET Political Science'));
    fireEvent.change(screen.getByLabelText('Next exam date: UGC NET Political Science'), {
      target: { value: '2026-12-18' },
    });
    fireEvent.change(screen.getByLabelText('Short name: UGC NET Political Science'), {
      target: { value: 'NET' },
    });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith([
        { examId: NET, nextExamDate: '2026-12-18', label: 'NET' },
      ]),
    );
    expect(await screen.findByText(dictionary.en['teacherProfile.saved'])).toBeInTheDocument();
  });

  it('sends null, not an empty string, for a date or a name left blank', async () => {
    const client = fakeClient();
    render(<TeacherExamsForm exams={EXAMS} items={[]} client={client} />);

    fireEvent.click(chip('CUET PG Political Science (HUQP18)'));
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith([
        { examId: CUET, nextExamDate: null, label: null },
      ]),
    );
  });

  it('starts from the dates already saved, so an edit is not a retype', () => {
    render(
      <TeacherExamsForm
        exams={EXAMS}
        items={[{ examId: NET, nextExamDate: '2026-12-18', label: 'NET' }]}
        client={fakeClient()}
      />,
    );

    expect(chip('UGC NET Political Science')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Next exam date: UGC NET Political Science')).toHaveValue(
      '2026-12-18',
    );
    expect(screen.getByLabelText('Short name: UGC NET Political Science')).toHaveValue('NET');
  });

  it('drops an exam when the chip is tapped again', async () => {
    const client = fakeClient();
    render(
      <TeacherExamsForm
        exams={EXAMS}
        items={[{ examId: NET, nextExamDate: '2026-12-18', label: 'NET' }]}
        client={client}
      />,
    );

    fireEvent.click(chip('UGC NET Political Science'));
    expect(screen.queryByLabelText('Next exam date: UGC NET Political Science')).toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(client.save).toHaveBeenCalledWith([]));
  });

  it('shows one fixed line when the save fails and keeps the typed date', async () => {
    const client = fakeClient({
      save: vi.fn(async () => {
        throw new Error('new row violates row-level security policy');
      }),
    });
    render(
      <TeacherExamsForm
        exams={EXAMS}
        items={[{ examId: NET, nextExamDate: '2026-12-18', label: 'NET' }]}
        client={client}
      />,
    );

    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(dictionary.en['teacherProfile.failed']);
    expect(alert).not.toHaveTextContent(/row-level security/i);
    expect(screen.getByLabelText('Next exam date: UGC NET Political Science')).toHaveValue(
      '2026-12-18',
    );
  });

  it('says so and saves nothing when Supabase is not set up', () => {
    const client = fakeClient();
    render(
      <TeacherExamsForm exams={EXAMS} items={[]} client={client} configured={false} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      dictionary.en['teacherProfile.notConfigured'],
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(client.save).not.toHaveBeenCalled();
  });

  it('labels everything in Hindi in hi mode', () => {
    render(<TeacherExamsForm exams={EXAMS} items={[]} client={fakeClient()} mode="hi" />);

    expect(chip('यूजीसी नेट राजनीति विज्ञान')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: dictionary.hi['teacherProfile.save'] }),
    ).toBeInTheDocument();
  });
});
