/**
 * Teacher review screen: PDF beside the question, then publish
 * (issue 11-ingest-job-review-publish).
 *
 * Definition of done: "the teacher checks each one next to its PDF page, edits
 * it, marks it Checked, and publishes. Publish stays off until every question
 * is checked."
 *
 * DESIGN.md section 8: on a laptop the PDF page is on the left and the
 * question form on the right; on a phone a tab switch "PDF | Question". Both
 * panels are in the DOM at 1024 px, so the tab buttons are the phone-only
 * control and the test drives them directly.
 *
 * The browser client and the `Live` stream are props, so the test injects
 * fakes: no real network call, no socket and no key (web/CLAUDE.md).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherReview } from '../teacher-review';
import { dictionary } from '@/lib/i18n';
import { createMemoryLive } from '@/lib/questions/memory-live';
import type {
  BrowserQuestionsClient,
  IngestJob,
  Question,
  QuestionEdit,
} from '@/lib/questions/types';
import type { Paper } from '@/lib/papers/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';
const NET = 'a4000001-0000-4000-8000-000000000001';
const JOB = '77777777-7777-4777-8777-777777777777';

const en = dictionary.en;

function paper(over: Partial<Paper> = {}): Paper {
  return {
    id: PAPER,
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: 6,
    label: 'Shift 1',
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'draft',
    ...over,
  };
}

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q-' + (over.number ?? 1),
    teacherId: TEACHER,
    paperId: PAPER,
    testId: null,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    correctIdx: 1,
    teacherExplanation: null,
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: false,
    status: 'draft',
    ...over,
  };
}

function job(over: Partial<IngestJob> = {}): IngestJob {
  return {
    id: JOB,
    teacherId: TEACHER,
    paperId: PAPER,
    pdfPath: 'papers/q.pdf',
    status: 'running',
    attempts: 1,
    error: null,
    questionCount: 0,
    ...over,
  };
}

function fakeClient(over: Partial<BrowserQuestionsClient> = {}): BrowserQuestionsClient {
  return {
    save: vi.fn(async (edit: QuestionEdit) =>
      question({
        ...edit,
        id: edit.id ?? 'q-new',
        teacherId: TEACHER,
        testId: null,
        topicId: null,
        imagePath: null,
        status: 'draft',
      }),
    ),
    publish: vi.fn(async () => 2),
    ...over,
  };
}

function setup(
  props: Partial<React.ComponentProps<typeof TeacherReview>> = {},
): {
  client: BrowserQuestionsClient;
  push: (job: IngestJob) => void;
} {
  const client = props.client ?? fakeClient();
  const memory = createMemoryLive();
  render(
    <TeacherReview
      paper={paper()}
      questions={[]}
      job={null}
      client={client}
      live={memory.live}
      {...props}
    />,
  );
  // Wrapped in `act`, because a Realtime push is a state change that comes
  // from outside React, exactly as it does in the browser.
  return { client, push: (next: IngestJob) => act(() => memory.push(next)) };
}

const saveButton = () => screen.getByRole('button', { name: en['review.save'] });
const publishButton = () => screen.getByRole('button', { name: en['review.publish'] });

describe('not ready states', () => {
  it('says so when the Supabase keys are missing', () => {
    render(<TeacherReview paper={paper()} questions={[]} job={null} configured={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(en['review.notConfigured']);
    expect(screen.queryByRole('button', { name: en['review.publish'] })).toBeNull();
  });

  it('says so when the paper is not the caller own', () => {
    render(<TeacherReview paper={null} questions={[]} job={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(en['review.notFound']);
  });
});

describe('the two panels', () => {
  it('shows the paper PDF next to the question form', () => {
    setup();
    const frame = screen.getByTitle(en['review.openPdf']);
    expect(frame).toHaveAttribute('src', `/api/papers/${PAPER}/download?kind=questions`);
    expect(screen.getByRole('link', { name: en['review.openPdf'] })).toHaveAttribute(
      'href',
      `/api/papers/${PAPER}/download?kind=questions`,
    );
  });

  it('says there is no PDF when the teacher only uploaded solutions', () => {
    setup({ paper: paper({ questionsPath: null }) });
    expect(screen.getByText(en['review.noPdf'])).toBeInTheDocument();
    expect(screen.queryByTitle(en['review.openPdf'])).toBeNull();
  });

  it('switches between PDF and Question on a phone', () => {
    setup();
    const pdfTab = screen.getByRole('tab', { name: en['review.tabPdf'] });
    const questionTab = screen.getByRole('tab', { name: en['review.tabQuestion'] });

    // The question side is the one a teacher works in, so it opens first.
    expect(questionTab).toHaveAttribute('aria-selected', 'true');
    expect(pdfTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(pdfTab);
    expect(pdfTab).toHaveAttribute('aria-selected', 'true');
    expect(questionTab).toHaveAttribute('aria-selected', 'false');
  });
});

describe('the split job', () => {
  it('says nothing when the PDF was never queued', () => {
    setup({ job: null });
    expect(screen.queryByText(en['job.running'])).toBeNull();
  });

  it('shows the job status that came from the server', () => {
    setup({ job: job({ status: 'queued' }) });
    expect(screen.getByText(en['job.queued'])).toBeInTheDocument();
  });

  it('follows the job over the pushed stream, with no timer', () => {
    const { push } = setup({ job: job({ status: 'queued' }) });

    push(job({ status: 'running', questionCount: 42 }));

    expect(screen.getByText(en['job.running'])).toBeInTheDocument();
    // "42 questions found", with the number in Latin digits in both languages.
    expect(screen.getByText(`42 ${en['job.found']}`)).toBeInTheDocument();
  });

  it('shows the error the splitter reported, so the teacher knows why', () => {
    const { push } = setup({ job: job({ status: 'running' }) });
    push(job({ status: 'failed', attempts: 3, error: 'Could not read the PDF' }));

    expect(screen.getByText(en['job.failed'])).toBeInTheDocument();
    expect(screen.getByText('Could not read the PDF')).toBeInTheDocument();
  });

  it('reloads the server data once the split has finished', () => {
    refresh.mockClear();
    const { push } = setup({ job: job({ status: 'running' }) });

    push(job({ status: 'running', questionCount: 3 }));
    expect(refresh).not.toHaveBeenCalled();

    push(job({ status: 'done', questionCount: 3 }));
    expect(refresh).toHaveBeenCalled();
  });

  it('stops watching when it goes away', () => {
    const memory = createMemoryLive();
    const view = render(
      <TeacherReview
        paper={paper()}
        questions={[]}
        job={job()}
        client={fakeClient()}
        live={memory.live}
      />,
    );
    expect(memory.watching()).toEqual([JOB]);
    view.unmount();
    expect(memory.watching()).toEqual([]);
  });
});

describe('walking the questions', () => {
  const three = [
    question({ number: 1, stem: 'First one' }),
    question({ number: 2, stem: 'Second one' }),
    question({ number: 3, stem: 'Third one' }),
  ];

  it('opens on the first question and says where the teacher is', () => {
    setup({ questions: three });
    expect(screen.getByLabelText(en['review.stem'])).toHaveValue('First one');
    expect(
      screen.getByText(`${en['review.question']} 1 ${en['review.of']} 3`),
    ).toBeInTheDocument();
  });

  it('steps forward and back', () => {
    setup({ questions: three });

    fireEvent.click(screen.getByRole('button', { name: en['review.next'] }));
    expect(screen.getByLabelText(en['review.stem'])).toHaveValue('Second one');

    fireEvent.click(screen.getByRole('button', { name: en['review.prev'] }));
    expect(screen.getByLabelText(en['review.stem'])).toHaveValue('First one');
  });

  it('stops at both ends instead of wrapping round', () => {
    setup({ questions: three });
    expect(screen.getByRole('button', { name: en['review.prev'] })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: en['review.next'] }));
    fireEvent.click(screen.getByRole('button', { name: en['review.next'] }));
    expect(screen.getByRole('button', { name: en['review.next'] })).toBeDisabled();
  });

  it('shows the questions in paper order, whatever order they arrived in', () => {
    setup({
      questions: [
        question({ number: 9, stem: 'Ninth' }),
        question({ number: 2, stem: 'Second' }),
      ],
    });
    expect(screen.getByLabelText(en['review.stem'])).toHaveValue('Second');
  });

  it('marks each question Draft or Checked', () => {
    setup({ questions: [question({ number: 1, checked: false })] });
    expect(screen.getByText(en['review.draft'])).toBeInTheDocument();
  });

  it('says there is nothing yet when the split found no questions', () => {
    setup({ questions: [] });
    expect(screen.getByText(en['review.none'])).toBeInTheDocument();
  });
});

describe('editing one question', () => {
  it('sends every field, with checked true, and says Saved', async () => {
    const client = fakeClient();
    setup({ client, questions: [question({ number: 4 })] });

    fireEvent.change(screen.getByLabelText(en['review.stem']), {
      target: { value: '  Who appoints the Governor?  ' },
    });
    fireEvent.change(screen.getByLabelText(en['review.optionA']), {
      target: { value: 'President' },
    });
    fireEvent.click(screen.getByLabelText(`${en['review.correct']} A`));
    fireEvent.change(screen.getByLabelText(en['review.explanation']), {
      target: { value: 'Article 155.' },
    });
    fireEvent.click(screen.getByLabelText(en['review.markChecked']));
    fireEvent.click(saveButton());

    await waitFor(() => expect(client.save).toHaveBeenCalled());

    expect(client.save).toHaveBeenCalledWith({
      id: 'q-4',
      paperId: PAPER,
      number: 4,
      stem: 'Who appoints the Governor?',
      options: ['President', 'Rajya Sabha', 'Both', 'Neither'],
      correctIdx: 0,
      teacherExplanation: 'Article 155.',
      lang: 'en',
      checked: true,
    });

    await waitFor(() =>
      expect(screen.getByText(en['review.saved'])).toBeInTheDocument(),
    );
  });

  it('refuses a blank question text without spending a request', async () => {
    const client = fakeClient();
    setup({ client, questions: [question()] });

    fireEvent.change(screen.getByLabelText(en['review.stem']), { target: { value: '   ' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en['review.needStem']),
    );
    expect(client.save).not.toHaveBeenCalled();
  });

  it('refuses three filled options, because a question has four', async () => {
    const client = fakeClient();
    setup({ client, questions: [question()] });

    fireEvent.change(screen.getByLabelText(en['review.optionD']), { target: { value: '' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en['review.needOptions']),
    );
    expect(client.save).not.toHaveBeenCalled();
  });

  it('turns a taken question number into its own line', async () => {
    const client = fakeClient({
      save: vi.fn(async () => {
        throw new Error('duplicate-number');
      }),
    });
    setup({ client, questions: [question()] });

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en['review.duplicateNumber']),
    );
  });

  it('never shows a server message, only our own line', async () => {
    const client = fakeClient({
      save: vi.fn(async () => {
        throw new Error('policy questions_update_own blocked this');
      }),
    });
    setup({ client, questions: [question()] });

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en['review.failed']),
    );
    expect(screen.queryByText(/questions_update_own/)).toBeNull();
  });
});

describe('adding a question by hand', () => {
  it('opens a blank form numbered one past the last question', async () => {
    const client = fakeClient();
    setup({ client, questions: [question({ number: 1 }), question({ number: 7 })] });

    fireEvent.click(screen.getByRole('button', { name: en['review.add'] }));

    expect(screen.getByLabelText(en['review.stem'])).toHaveValue('');
    expect(screen.getByLabelText(en['review.number'])).toHaveValue(8);
  });

  it('saves it with no id, so the server inserts instead of patching', async () => {
    const client = fakeClient();
    setup({ client, questions: [] });

    fireEvent.change(screen.getByLabelText(en['review.stem']), {
      target: { value: 'A typed question' },
    });
    for (const key of [
      'review.optionA',
      'review.optionB',
      'review.optionC',
      'review.optionD',
    ] as const) {
      fireEvent.change(screen.getByLabelText(en[key]), { target: { value: 'An option' } });
    }
    fireEvent.click(saveButton());

    await waitFor(() => expect(client.save).toHaveBeenCalled());
    const sent = (client.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as QuestionEdit;
    expect(sent.id).toBeNull();
    expect(sent.number).toBe(1);
  });

  it('adds the stored question to the list, so Publish counts it', async () => {
    const client = fakeClient({
      save: vi.fn(async (edit: QuestionEdit) =>
        question({ ...edit, id: 'q-new', number: edit.number, checked: false }),
      ),
    });
    setup({ client, questions: [] });

    fireEvent.change(screen.getByLabelText(en['review.stem']), {
      target: { value: 'A typed question' },
    });
    for (const key of [
      'review.optionA',
      'review.optionB',
      'review.optionC',
      'review.optionD',
    ] as const) {
      fireEvent.change(screen.getByLabelText(en[key]), { target: { value: 'An option' } });
    }
    fireEvent.click(saveButton());

    // One unchecked question now exists, so Publish is off.
    await waitFor(() => expect(publishButton()).toBeDisabled());
    expect(screen.getByText(en['review.blockedUnchecked'])).toBeInTheDocument();
  });
});

describe('publish', () => {
  it('is OFF while one question is unchecked, and says why (F-D3)', () => {
    setup({
      questions: [question({ number: 1, checked: true }), question({ number: 2, checked: false })],
    });

    expect(publishButton()).toBeDisabled();
    expect(screen.getByText(en['review.blockedUnchecked'])).toBeInTheDocument();
  });

  it('is OFF while the split is still running (Risk 1)', () => {
    setup({
      job: job({ status: 'running' }),
      questions: [question({ checked: true })],
    });

    expect(publishButton()).toBeDisabled();
    expect(screen.getByText(en['review.blockedSplitting'])).toBeInTheDocument();
  });

  it('turns ON as soon as the pushed job says the split finished', async () => {
    const { push } = setup({
      job: job({ status: 'running' }),
      questions: [question({ checked: true })],
    });
    expect(publishButton()).toBeDisabled();

    push(job({ status: 'done', questionCount: 1 }));

    await waitFor(() => expect(publishButton()).toBeEnabled());
  });

  it('is ON for a paper with no questions, because the PDF is content too', () => {
    setup({ questions: [], job: null });
    expect(publishButton()).toBeEnabled();
  });

  it('publishes and says Published', async () => {
    const client = fakeClient();
    setup({ client, questions: [question({ checked: true })] });

    fireEvent.click(publishButton());

    await waitFor(() => expect(client.publish).toHaveBeenCalledWith(PAPER));
    await waitFor(() =>
      expect(screen.getByText(en['review.published'])).toBeInTheDocument(),
    );
  });

  it('shows the right line when the server refuses, because the page was stale', async () => {
    const client = fakeClient({
      publish: vi.fn(async () => {
        throw new Error('unchecked');
      }),
    });
    setup({ client, questions: [question({ checked: true })] });

    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en['review.blockedUnchecked']),
    );
  });

  it('never shows a server message when publish breaks', async () => {
    const client = fakeClient({
      publish: vi.fn(async () => {
        throw new Error('function public.publish_paper does not exist');
      }),
    });
    setup({ client, questions: [question({ checked: true })] });

    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en['review.failed']),
    );
    expect(screen.queryByText(/publish_paper/)).toBeNull();
  });
});

describe('Hindi', () => {
  it('writes every label in both languages in `both` mode', () => {
    setup({ mode: 'both', questions: [question()] });

    expect(screen.getByText(dictionary.hi['review.title'])).toBeInTheDocument();
    expect(screen.getByText(en['review.title'])).toBeInTheDocument();
    // An aria-label in `both` mode is "English / Hindi", one string.
    expect(
      screen.getByLabelText(`${en['review.stem']} / ${dictionary.hi['review.stem']}`),
    ).toBeInTheDocument();
  });
});
