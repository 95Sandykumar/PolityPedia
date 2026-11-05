/**
 * Teacher Papers: upload form plus the teacher's own list
 * (issue 10-papers-upload-browse).
 *
 * Definition of done: "A teacher uploads a past paper PDF (questions,
 * solutions or both) with exam, year and optional month."
 *
 * The browser client is a prop, so the test injects a fake: no real network
 * call, no real key and no real 31 MB file (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherPapersForm } from '../teacher-papers-form';
import type { Exam } from '@/lib/exams/types';
import type { BrowserPapersClient, Paper } from '@/lib/papers/types';
import { dictionary } from '@/lib/i18n';

const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';
const TEACHER = '44444444-4444-4444-8444-444444444444';

function exam(id: string, nameEn: string, nameHi: string): Exam {
  return {
    id,
    code: nameEn.toLowerCase(),
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
  exam(NET, 'UGC NET Political Science', 'यूजीसी नेट राजनीति विज्ञान'),
  exam(CUET, 'CUET PG Political Science', 'सीयूईटी पीजी राजनीति विज्ञान'),
];

const MADE: Paper = {
  id: 'new-paper',
  teacherId: TEACHER,
  examId: NET,
  year: 2024,
  month: 6,
  label: 'Shift 1',
  questionsPath: 'papers/q.pdf',
  solutionsPath: null,
  status: 'draft',
};

function fakeClient(overrides: Partial<BrowserPapersClient> = {}): BrowserPapersClient {
  return { create: vi.fn(async () => MADE), ...overrides };
}

function smallPdf(name = 'q.pdf') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' });
}

const en = dictionary.en;
const uploadButton = () => screen.getByRole('button', { name: en['papers.upload'] });

function fill(values: { label?: string; year?: string; month?: string } = {}) {
  fireEvent.change(screen.getByLabelText(en['papers.label']), {
    target: { value: values.label ?? 'Shift 1' },
  });
  fireEvent.change(screen.getByLabelText(en['papers.year']), {
    target: { value: values.year ?? '2024' },
  });
  if (values.month !== undefined) {
    fireEvent.change(screen.getByLabelText(en['papers.month']), {
      target: { value: values.month },
    });
  }
}

describe('TeacherPapersForm', () => {
  it('shows the not-configured line instead of a form when Supabase is missing', () => {
    render(
      <TeacherPapersForm exams={EXAMS} papers={[]} client={fakeClient()} configured={false} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['papers.notConfigured']);
    expect(screen.queryByRole('button', { name: en['papers.upload'] })).toBeNull();
  });

  it('sends exam, year, month, label and the PDF', async () => {
    const client = fakeClient();
    render(<TeacherPapersForm exams={EXAMS} papers={[]} client={client} />);

    fill({ month: '6' });
    const file = smallPdf();
    fireEvent.change(screen.getByLabelText(en['papers.questionsPdf']), {
      target: { files: [file] },
    });
    fireEvent.click(uploadButton());

    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create).toHaveBeenCalledWith({
      examId: NET,
      year: 2024,
      month: 6,
      label: 'Shift 1',
      questions: file,
      solutions: null,
    });
    expect(await screen.findByText(en['papers.uploaded'])).toBeInTheDocument();
  });

  it('sends no month when the teacher leaves the month alone', async () => {
    const client = fakeClient();
    render(<TeacherPapersForm exams={EXAMS} papers={[]} client={client} />);

    fill();
    fireEvent.change(screen.getByLabelText(en['papers.questionsPdf']), {
      target: { files: [smallPdf()] },
    });
    fireEvent.click(uploadButton());

    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ month: null }));
  });

  it('adds the new paper to the list without a page reload', async () => {
    render(<TeacherPapersForm exams={EXAMS} papers={[]} client={fakeClient()} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['papers.none']);

    fill();
    fireEvent.change(screen.getByLabelText(en['papers.questionsPdf']), {
      target: { files: [smallPdf()] },
    });
    fireEvent.click(uploadButton());

    expect(await screen.findByText(en['papers.draft'])).toBeInTheDocument();
  });

  it('says the file is too big when the client refuses 31 MB', async () => {
    const client = fakeClient({
      create: vi.fn(async () => {
        throw new Error('too-big');
      }),
    });
    render(<TeacherPapersForm exams={EXAMS} papers={[]} client={client} />);

    fill();
    fireEvent.change(screen.getByLabelText(en['papers.questionsPdf']), {
      target: { files: [smallPdf()] },
    });
    fireEvent.click(uploadButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(en['papers.tooBig']);
  });

  it('says the paper already exists when the server answers 409', async () => {
    const client = fakeClient({
      create: vi.fn(async () => {
        throw new Error('duplicate');
      }),
    });
    render(<TeacherPapersForm exams={EXAMS} papers={[]} client={client} />);

    fill();
    fireEvent.change(screen.getByLabelText(en['papers.questionsPdf']), {
      target: { files: [smallPdf()] },
    });
    fireEvent.click(uploadButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(en['papers.duplicate']);
  });

  it('asks for a PDF before it calls the server at all', async () => {
    const client = fakeClient();
    render(<TeacherPapersForm exams={EXAMS} papers={[]} client={client} />);

    fill();
    fireEvent.click(uploadButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(en['papers.needPdf']);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('lists the papers the teacher already has, drafts included', () => {
    render(
      <TeacherPapersForm
        exams={EXAMS}
        papers={[{ ...MADE, id: 'old', label: 'Older paper', status: 'draft' }]}
        client={fakeClient()}
      />,
    );

    expect(screen.getByText('Older paper')).toBeInTheDocument();
    expect(screen.getByText(en['papers.draft'])).toBeInTheDocument();
  });
});
