/**
 * Issue 16-set-access-mock-list: the student's Mock test list.
 *
 * This is the definition of done, read off the screen:
 *
 *  * each set shows a price, or "Unlocked" once it is paid for,
 *  * a taken test shows a tick and its score, and its button says Review,
 *  * an untaken open test says Attempt,
 *  * a locked test shows a lock and NO button of its own,
 *  * the set shows ONE "Unlock Rs 399" button, which starts a real checkout
 *    (issue 26-razorpay-order-checkout replaced the "coming soon" line),
 *  * the free sample is open to everybody,
 *  * above the list: Topic (Full paper by default) and Practice | Exam.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MockList } from '../mock-list';
import { buildMockRows, type MockSetRow } from '@/lib/set-access/types';

const TEACHER = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const TEST_1 = '33333333-3333-4333-8333-333333333333';
const TEST_2 = '44444444-4444-4444-8444-444444444444';

const SETS = [{ id: SET, title: 'UGC NET Mock Set', priceInr: 399 }];
const TESTS = [
  { id: TEST_1, setId: SET, title: 'Test 1', position: 1, isFreeSample: true },
  { id: TEST_2, setId: SET, title: 'Test 2', position: 2, isFreeSample: false },
];

function rows(options: { unlocked?: boolean; scores?: { testId: string; score: number }[] } = {}) {
  return buildMockRows({
    sets: SETS,
    tests: TESTS,
    access: options.unlocked
      ? [{ setId: SET, source: 'admin' as const, validUntil: 'infinity' }]
      : [],
    scores: options.scores ?? [],
  });
}

function draw(sets: MockSetRow[]) {
  return render(<MockList sets={sets} teacherId={TEACHER} />);
}

const topicField = () => screen.getByRole('combobox', { name: 'Topic' });
const unlockButton = () => screen.getByRole('button', { name: 'Unlock Rs 399' });

describe('a locked set', () => {
  it('shows the price, not the word Unlocked', () => {
    draw(rows());
    expect(screen.getByText('Rs 399')).toBeInTheDocument();
    expect(screen.queryByText('Unlocked')).not.toBeInTheDocument();
  });

  it('opens the free sample and locks the rest', () => {
    draw(rows());

    // Test 1 is the free sample: one Attempt button.
    expect(screen.getByRole('link', { name: 'Test 1: Attempt' })).toBeInTheDocument();
    // Test 2 is locked: a lock, and no button of its own.
    expect(screen.getByRole('img', { name: 'Locked' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Test 2: Attempt' })).not.toBeInTheDocument();
  });

  it('shows exactly ONE Unlock button for the whole set', () => {
    draw(rows());
    expect(screen.getAllByRole('button', { name: 'Unlock Rs 399' })).toHaveLength(1);
  });

  it('offers a coupon box with the Unlock button', () => {
    draw(rows());
    expect(screen.getByRole('textbox', { name: 'Coupon code (optional)' })).toBeInTheDocument();
  });
});

describe('an unlocked set', () => {
  it('says Unlocked and opens every test', () => {
    draw(rows({ unlocked: true }));

    expect(screen.getByText('Unlocked')).toBeInTheDocument();
    expect(screen.queryByText('Rs 399')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Test 1: Attempt' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Test 2: Attempt' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Locked' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock Rs 399' })).not.toBeInTheDocument();
  });

  it('shows a tick and the score on a taken test, and says Review', () => {
    draw(rows({ unlocked: true, scores: [{ testId: TEST_1, score: 64 }] }));

    const taken = screen.getByRole('link', { name: 'Test 1: Review' });
    expect(taken).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Taken' })).toBeInTheDocument();
    expect(screen.getByLabelText('Score: 64')).toHaveTextContent('64');

    // The untaken one still says Attempt.
    expect(screen.getByRole('link', { name: 'Test 2: Attempt' })).toBeInTheDocument();
  });

  /**
   * Persona-1 gap 5 (ticket 57c): "Review" pointed at `/play`, the START
   * route, so every look at a finished test opened a blank new sitting and
   * left an `attempts` row behind. A taken row goes to `/review`, which
   * writes nothing; Retake on that page is the only way back to `/play`.
   */
  it('sends a taken test to the REVIEW route, never to the player', () => {
    draw(rows({ unlocked: true, scores: [{ testId: TEST_1, score: 64 }] }));

    expect(screen.getByRole('link', { name: 'Test 1: Review' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_1}/review`,
    );
  });

  it('leaves an untaken test on the play route', () => {
    draw(rows({ unlocked: true, scores: [{ testId: TEST_1, score: 64 }] }));

    expect(screen.getByRole('link', { name: 'Test 2: Attempt' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_2}/play?mode=practice`,
    );
  });

  /**
   * The mode and the topic are a choice about a NEW sitting, so they have no
   * business on a read-only page: the review route reads the newest submitted
   * sitting and takes its mode from the row.
   */
  it('keeps the mode and the topic out of the review link', () => {
    render(
      <MockList
        sets={rows({ unlocked: true, scores: [{ testId: TEST_1, score: 64 }] })}
        teacherId={TEACHER}
        topics={[{ id: 'polity', name: 'Indian Polity' }]}
      />,
    );
    fireEvent.change(topicField(), { target: { value: 'polity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exam' }));

    expect(screen.getByRole('link', { name: 'Test 1: Review' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_1}/review`,
    );
    // The untaken row still carries both, because it starts a sitting.
    expect(screen.getByRole('link', { name: 'Test 2: Attempt' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_2}/play?mode=exam&topic=polity`,
    );
  });
});

describe('topic and mode', () => {
  it('starts on Full paper and leaves it out of the link', () => {
    draw(rows());
    expect(topicField()).toHaveValue('all');
    expect(screen.getByRole('link', { name: 'Test 1: Attempt' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_1}/play?mode=practice`,
    );
  });

  it('carries a chosen topic into the link', () => {
    // A topic has to BE in the dropdown before it can be picked, so this test
    // hands the catalogue in. v1 ships with it empty (there is no topics
    // table yet), and the page then shows Full paper on its own.
    render(
      <MockList
        sets={rows()}
        teacherId={TEACHER}
        topics={[{ id: 'polity', name: 'Indian Polity' }]}
      />,
    );
    fireEvent.change(topicField(), { target: { value: 'polity' } });

    expect(screen.getByRole('link', { name: 'Test 1: Attempt' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_1}/play?mode=practice&topic=polity`,
    );
  });

  it('starts on Practice and switches to Exam', () => {
    draw(rows());

    const practice = screen.getByRole('button', { name: 'Practice' });
    const exam = screen.getByRole('button', { name: 'Exam' });
    expect(practice).toHaveAttribute('aria-pressed', 'true');
    expect(exam).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(exam);
    expect(exam).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: 'Test 1: Attempt' })).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST_1}/play?mode=exam`,
    );
  });

  it('offers a topic from the catalogue when there is one', () => {
    render(
      <MockList
        sets={rows()}
        teacherId={TEACHER}
        topics={[{ id: 'polity', name: 'Indian Polity' }]}
      />,
    );
    const options = within(topicField()).getAllByRole('option');
    expect(options.map((one) => one.textContent)).toEqual(['Full paper', 'Indian Polity']);
  });
});

describe('empty states', () => {
  it('says so when the teacher has no live set', () => {
    draw([]);
    expect(screen.getByRole('status')).toHaveTextContent(
      'No mock tests yet. Your teacher adds them soon.',
    );
  });

  it('says so when a set has no test in it yet', () => {
    draw(buildMockRows({ sets: SETS, tests: [], access: [] }));
    expect(screen.getByRole('status')).toHaveTextContent('No tests in this set yet');
  });
});

describe('Hindi', () => {
  it('writes the Unlock button in Hindi with a rupee sign', () => {
    render(<MockList sets={rows()} teacherId={TEACHER} mode="hi" />);
    expect(screen.getByRole('button', { name: 'खोलें ₹399' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Test 1: टेस्ट दें' })).toBeInTheDocument();
  });
});
