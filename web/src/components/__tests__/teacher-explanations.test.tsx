/**
 * Issue 24-revision-teacher-edit: the teacher screen that corrects AI text.
 *
 * Definition of done: "A teacher opens an AI explanation of one of their
 * questions, edits the text, and saves. Students then see the edited version."
 * This file is the first two thirds of that sentence; `test/teacher-edit.test.ts`
 * is the last third, in real Postgres.
 *
 * The client is a prop, so the test injects a fake: no real network call and
 * no real key (web/CLAUDE.md).
 *
 * Permission is NOT this screen's job. The gate is the
 * `ai_explanations_update_owner` policy and the `ai_explanations_teacher_edit`
 * trigger inside Postgres.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherExplanations } from '../teacher-explanations';
import { dictionary } from '@/lib/i18n';
import type {
  BrowserTeacherExplanationsClient,
  TeacherExplanation,
} from '@/lib/ai/teacher-edit';

const QUESTION = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

function explanation(over: Partial<TeacherExplanation> = {}): TeacherExplanation {
  return {
    questionId: QUESTION,
    lang: 'en',
    stem: 'Which house is the Council of States?',
    number: 1,
    body: {
      exam: 'UGC NET',
      topic: 'Parliament',
      question: 'Which house is the Council of States?',
      sections: [{ heading: 'Answer', body: 'The Lok Sabha.' }],
      remember: 'Lok Sabha = Council of States.',
    },
    editedByTeacher: false,
    ...over,
  };
}

function fakeClient(
  over: Partial<BrowserTeacherExplanationsClient> = {},
): BrowserTeacherExplanationsClient {
  return {
    edit: vi.fn(async (input) => explanation({ ...input, editedByTeacher: true })),
    ...over,
  };
}

const openButton = () => screen.getAllByRole('button', { name: dictionary.en['teacherEdit.open'] });
const saveButton = () => screen.getByRole('button', { name: dictionary.en['teacherEdit.save'] });
const bodyBox = () => screen.getByLabelText(dictionary.en['teacherEdit.body']);
const headingBox = () => screen.getByLabelText(dictionary.en['teacherEdit.heading']);
const rememberBox = () => screen.getByLabelText(dictionary.en['teacherEdit.rememberLine']);

describe('TeacherExplanations: the list', () => {
  it('says so when there is nothing to correct', () => {
    render(<TeacherExplanations explanations={[]} client={fakeClient()} />);
    expect(screen.getByText(dictionary.en['teacherEdit.none'])).toBeInTheDocument();
  });

  it('says so when Supabase is not set up, and shows no form', () => {
    render(<TeacherExplanations explanations={[]} client={fakeClient()} configured={false} />);
    expect(screen.getByText(dictionary.en['teacherEdit.notConfigured'])).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: dictionary.en['teacherEdit.open'] })).toBeNull();
  });

  it('shows the question and the AI text, and labels it as AI written', () => {
    render(<TeacherExplanations explanations={[explanation()]} client={fakeClient()} />);

    // The paper number is on the row, so a teacher can find the question in
    // the PDF they uploaded.
    expect(screen.getByText('1. Which house is the Council of States?')).toBeInTheDocument();
    expect(screen.getByText('The Lok Sabha.')).toBeInTheDocument();
    expect(screen.getByText(dictionary.en['teacherEdit.byAi'])).toBeInTheDocument();
  });

  it('labels an already corrected one as the teacher own work', () => {
    render(
      <TeacherExplanations
        explanations={[explanation({ editedByTeacher: true })]}
        client={fakeClient()}
      />,
    );
    expect(screen.getByText(dictionary.en['teacherEdit.byYou'])).toBeInTheDocument();
    expect(screen.queryByText(dictionary.en['teacherEdit.byAi'])).toBeNull();
  });

  it('shows every label in both languages when the teacher asked for both', () => {
    render(<TeacherExplanations explanations={[explanation()]} client={fakeClient()} mode="both" />);
    expect(screen.getByText(dictionary.hi['teacherEdit.title'])).toBeInTheDocument();
    expect(screen.getByText(dictionary.en['teacherEdit.title'])).toBeInTheDocument();
  });

  it('opens one row at a time, so two forms cannot be saved out of order', () => {
    render(
      <TeacherExplanations
        explanations={[explanation(), explanation({ questionId: OTHER, number: 2 })]}
        client={fakeClient()}
      />,
    );

    fireEvent.click(openButton()[0]);
    expect(screen.getAllByLabelText(dictionary.en['teacherEdit.body'])).toHaveLength(1);

    fireEvent.click(openButton()[0]);
    expect(screen.getAllByLabelText(dictionary.en['teacherEdit.body'])).toHaveLength(1);
  });
});

describe('TeacherExplanations: correcting the text', () => {
  it('opens the form with the AI text already in it', () => {
    render(<TeacherExplanations explanations={[explanation()]} client={fakeClient()} />);
    fireEvent.click(openButton()[0]);

    expect(bodyBox()).toHaveValue('The Lok Sabha.');
    expect(headingBox()).toHaveValue('Answer');
    expect(rememberBox()).toHaveValue('Lok Sabha = Council of States.');
  });

  it('sends the corrected text and shows the new version', async () => {
    const client = fakeClient();
    render(<TeacherExplanations explanations={[explanation()]} client={client} />);

    fireEvent.click(openButton()[0]);
    fireEvent.change(bodyBox(), { target: { value: 'The Rajya Sabha. Article 80.' } });
    fireEvent.change(rememberBox(), { target: { value: 'Rajya Sabha = Council of States.' } });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByText(dictionary.en['teacherEdit.saved'])).toBeInTheDocument();
    });

    expect(client.edit).toHaveBeenCalledWith({
      questionId: QUESTION,
      lang: 'en',
      body: {
        exam: 'UGC NET',
        topic: 'Parliament',
        question: 'Which house is the Council of States?',
        sections: [{ heading: 'Answer', body: 'The Rajya Sabha. Article 80.' }],
        remember: 'Rajya Sabha = Council of States.',
      },
    });

    // The row now reads as the teacher's own work, which is the whole point of
    // F7: a student must not see corrected text credited to the model.
    expect(screen.getByText('The Rajya Sabha. Article 80.')).toBeInTheDocument();
    expect(screen.getByText(dictionary.en['teacherEdit.byYou'])).toBeInTheDocument();
    expect(screen.queryByText(dictionary.en['teacherEdit.byAi'])).toBeNull();
  });

  it('refuses to send a blank correction, and does not call the client', () => {
    const client = fakeClient();
    render(<TeacherExplanations explanations={[explanation()]} client={client} />);

    fireEvent.click(openButton()[0]);
    fireEvent.change(bodyBox(), { target: { value: '   ' } });
    fireEvent.click(saveButton());

    expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['teacherEdit.needText']);
    expect(client.edit).not.toHaveBeenCalled();
  });

  it('keeps the typed text when the save fails, so nothing is retyped', async () => {
    const client = fakeClient({
      edit: vi.fn(async () => {
        throw new Error('Request failed with status 502');
      }),
    });
    render(<TeacherExplanations explanations={[explanation()]} client={client} />);

    fireEvent.click(openButton()[0]);
    fireEvent.change(bodyBox(), { target: { value: 'The Rajya Sabha.' } });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['teacherEdit.failed']);
    });

    expect(bodyBox()).toHaveValue('The Rajya Sabha.');
    // Nothing was saved, so the row still says AI.
    expect(screen.getByText(dictionary.en['teacherEdit.byAi'])).toBeInTheDocument();
  });

  it('never shows the thrown message, which may quote Postgres', async () => {
    const client = fakeClient({
      edit: vi.fn(async () => {
        throw new Error('new row violates row-level security policy for table');
      }),
    });
    render(<TeacherExplanations explanations={[explanation()]} client={client} />);

    fireEvent.click(openButton()[0]);
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['teacherEdit.failed']);
    });
    expect(screen.queryByText(/row-level security/)).toBeNull();
  });

  it('closes the form on cancel and leaves the text alone', () => {
    render(<TeacherExplanations explanations={[explanation()]} client={fakeClient()} />);

    fireEvent.click(openButton()[0]);
    fireEvent.change(bodyBox(), { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: dictionary.en['teacherEdit.cancel'] }));

    expect(screen.queryByLabelText(dictionary.en['teacherEdit.body'])).toBeNull();
    expect(screen.getByText('The Lok Sabha.')).toBeInTheDocument();
  });
});
