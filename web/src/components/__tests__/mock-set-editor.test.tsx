/**
 * One mock set: reprice it, add tests, add questions, publish
 * (issue 15-mock-sets-authoring).
 *
 * Definition of done, the part this screen owns: "adds tests (Test 1 can be a
 * free sample), adds questions, ... and publishes".
 *
 * The question form is issue 11's `QuestionForm`, REUSED with a `test_id`
 * instead of a `paper_id`. The test below proves the reuse by reading what the
 * save sends.
 *
 * Both browser clients are props, so the test injects fakes: no real network
 * call and no key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MockSetEditor } from '../mock-set-editor';
import { dictionary } from '@/lib/i18n';
import type {
  BrowserMockSetsClient,
  MockSet,
  MockTest,
  MockTestDraft,
} from '@/lib/mocks/types';
import type { BrowserQuestionsClient, Question, QuestionEdit } from '@/lib/questions/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const TEACHER = '44444444-4444-4444-8444-444444444444';
const SET = '55555555-5555-4555-8555-555555555555';
const TEST_ONE = '66666666-6666-4666-8666-666666666666';
const TEST_TWO = '77777777-7777-4777-8777-777777777777';
const NET = 'a4000001-0000-4000-8000-000000000001';

const en = dictionary.en;

function set(over: Partial<MockSet> = {}): MockSet {
  return {
    id: SET,
    teacherId: TEACHER,
    examId: NET,
    title: 'Full length set 1',
    priceInr: 349,
    status: 'draft',
    ...over,
  };
}

function test(over: Partial<MockTest> = {}): MockTest {
  return {
    id: TEST_ONE,
    setId: SET,
    title: 'Test 1',
    position: 1,
    durationMin: 120,
    isFreeSample: true,
    ...over,
  };
}

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    teacherId: TEACHER,
    paperId: null,
    testId: TEST_ONE,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    correctIdx: 1,
    teacherExplanation: null,
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'draft',
    ...over,
  };
}

function mocksClient(over: Partial<BrowserMockSetsClient> = {}): BrowserMockSetsClient {
  return {
    saveSet: vi.fn(async (edit) => set({ priceInr: edit.priceInr })),
    saveTest: vi.fn(async (_setId: string, draft: MockTestDraft) => ({
      id: TEST_TWO,
      setId: SET,
      ...draft,
    })),
    publish: vi.fn(async () => 2),
    ...over,
  };
}

function questionsClient(
  over: Partial<BrowserQuestionsClient> = {},
): BrowserQuestionsClient {
  return {
    save: vi.fn(async (edit: QuestionEdit) =>
      question({ id: edit.id ?? 'q-new', number: edit.number, checked: edit.checked }),
    ),
    publish: vi.fn(async () => 0),
    ...over,
  };
}

function view(props: Partial<Parameters<typeof MockSetEditor>[0]> = {}) {
  return render(
    <MockSetEditor
      set={set()}
      tests={[test()]}
      questions={[question()]}
      sharePct={50}
      client={mocksClient()}
      questionsClient={questionsClient()}
      {...props}
    />,
  );
}

describe('a set that is not there', () => {
  it('says not found, and shows no price box', () => {
    view({ set: null });
    expect(screen.getByText(en['mocks.notFound'])).toBeInTheDocument();
    expect(screen.queryByLabelText(en['mocks.price'])).not.toBeInTheDocument();
  });

  it('says not configured when the keys are missing', () => {
    view({ configured: false });
    expect(screen.getByText(en['mocks.notConfigured'])).toBeInTheDocument();
  });
});

describe('repricing the set', () => {
  it('opens at the stored price and shows what a sale pays', () => {
    view();
    expect((screen.getByLabelText(en['mocks.price']) as HTMLInputElement).value).toBe('349');
    // 349 / 1.18 x 0.98 x 0.50 = 144.9..., so 144.
    expect(screen.getByTestId('earning-estimate').textContent).toContain('144');
  });

  it('patches the SAME set, carrying its id and exam', async () => {
    const data = mocksClient();
    view({ client: data });

    fireEvent.click(screen.getByRole('button', { name: en['mocks.priceUp'] }));
    fireEvent.click(screen.getByRole('button', { name: en['mocks.savePrice'] }));

    await waitFor(() =>
      expect(data.saveSet).toHaveBeenCalledWith({
        id: SET,
        examId: NET,
        title: 'Full length set 1',
        priceInr: 359,
      }),
    );
  });
});

describe('the tests inside the set', () => {
  it('shows each test, its minutes and the free sample badge', () => {
    view({
      tests: [test(), test({ id: TEST_TWO, title: 'Test 2', position: 2, isFreeSample: false })],
    });

    expect(screen.getByText('Test 1')).toBeInTheDocument();
    expect(screen.getByText('Test 2')).toBeInTheDocument();
    // Only Test 1 carries the badge. Read by testid, because the same words
    // are the label of the free-sample checkbox in the add form below.
    expect(screen.getByTestId(`free-sample-${TEST_ONE}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`free-sample-${TEST_TWO}`)).not.toBeInTheDocument();
  });

  it('says so when there are no tests yet', () => {
    view({ tests: [], questions: [] });
    expect(screen.getByText(en['mocks.noTests'])).toBeInTheDocument();
  });

  it('offers the next position, so a gap never clashes', () => {
    view({ tests: [test(), test({ id: TEST_TWO, position: 4, isFreeSample: false })] });
    expect((screen.getByLabelText(en['mocks.testNumber']) as HTMLInputElement).value).toBe(
      '5',
    );
  });

  it('lets Test 1 be the free sample, and nothing else (V11)', () => {
    // An empty set: the next test is number 1, so the box is usable.
    const { unmount } = view({ tests: [], questions: [] });
    expect(screen.getByLabelText(en['mocks.freeSample'])).not.toBeDisabled();
    unmount();

    // A set that already has Test 1: the next test is number 2, so the box is
    // off and the reason is on the screen.
    view();
    expect(screen.getByLabelText(en['mocks.freeSample'])).toBeDisabled();
    expect(screen.getByText(en['mocks.freeSampleHint'])).toBeInTheDocument();
  });

  it('adds a test and puts it in the list with no reload', async () => {
    const data = mocksClient();
    view({ tests: [], questions: [], client: data });

    fireEvent.change(screen.getByLabelText(en['mocks.testName']), {
      target: { value: '  Test 1  ' },
    });
    fireEvent.change(screen.getByLabelText(en['mocks.duration']), {
      target: { value: '90' },
    });
    fireEvent.click(screen.getByLabelText(en['mocks.freeSample']));
    fireEvent.click(screen.getByRole('button', { name: en['mocks.addTest'] }));

    await waitFor(() =>
      expect(data.saveTest).toHaveBeenCalledWith(SET, {
        title: 'Test 1',
        position: 1,
        durationMin: 90,
        isFreeSample: true,
      }),
    );
    await waitFor(() => expect(screen.getByText('Test 1')).toBeInTheDocument());
  });

  it('turns the taken-position CODE into one line', async () => {
    const data = mocksClient({
      saveTest: vi.fn(async () => {
        throw new Error('duplicate-position');
      }),
    });
    view({ tests: [], questions: [], client: data });

    fireEvent.change(screen.getByLabelText(en['mocks.testName']), {
      target: { value: 'Clash' },
    });
    fireEvent.click(screen.getByRole('button', { name: en['mocks.addTest'] }));

    await waitFor(() =>
      expect(screen.getByText(en['mocks.duplicatePosition'])).toBeInTheDocument(),
    );
  });
});

describe('the questions of one test (issue 11 form, reused)', () => {
  it('sends a testId and a null paperId', async () => {
    const data = questionsClient();
    view({ questionsClient: data });

    // Open the questions of Test 1.
    fireEvent.click(screen.getAllByRole('button', { name: en['mocks.questions'] })[0]);

    fireEvent.change(screen.getByLabelText(en['review.stem']), {
      target: { value: 'Who appoints the Governor?' },
    });
    for (const [index, key] of (
      ['review.optionA', 'review.optionB', 'review.optionC', 'review.optionD'] as const
    ).entries()) {
      fireEvent.change(screen.getByLabelText(en[key]), {
        target: { value: `Option ${index}` },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: en['review.save'] }));

    await waitFor(() => expect(data.save).toHaveBeenCalled());
    const [edit] = (data.save as ReturnType<typeof vi.fn>).mock.calls[0] as [QuestionEdit];
    expect(edit.testId).toBe(TEST_ONE);
    expect(edit.paperId).toBeNull();
  });

  it('shows how many questions a test already has', () => {
    view({
      questions: [question(), question({ id: 'q-2', number: 2, checked: false })],
    });
    // Both questions hang on Test 1, so its row counts two.
    expect(screen.getByTestId(`question-count-${TEST_ONE}`).textContent).toContain('2');
  });
});

describe('publishing the set', () => {
  it('is off with no tests, and says why', () => {
    view({ tests: [], questions: [] });

    expect(screen.getByRole('button', { name: en['mocks.publish'] })).toBeDisabled();
    expect(screen.getByText(en['mocks.blockedNoTests'])).toBeInTheDocument();
  });

  it('is off while ONE question is unchecked, and says why', () => {
    view({ questions: [question(), question({ id: 'q-2', number: 2, checked: false })] });

    expect(screen.getByRole('button', { name: en['mocks.publish'] })).toBeDisabled();
    expect(screen.getByText(en['mocks.blockedUnchecked'])).toBeInTheDocument();
  });

  it('is on once every question is checked, and publishes', async () => {
    const data = mocksClient();
    view({ client: data });

    const button = screen.getByRole('button', { name: en['mocks.publish'] });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(data.publish).toHaveBeenCalledWith(SET));
    await waitFor(() =>
      expect(screen.getByText(en['mocks.published'])).toBeInTheDocument(),
    );
  });

  it('shows the database refusal when the page was stale', async () => {
    const data = mocksClient({
      publish: vi.fn(async () => {
        throw new Error('unchecked');
      }),
    });
    view({ client: data });

    fireEvent.click(screen.getByRole('button', { name: en['mocks.publish'] }));

    await waitFor(() =>
      expect(screen.getByText(en['mocks.blockedUnchecked'])).toBeInTheDocument(),
    );
  });

  it('shows the live badge for a set that is already out', () => {
    view({ set: set({ status: 'live' }) });
    expect(screen.getByText(en['mocks.live'])).toBeInTheDocument();
  });
});
