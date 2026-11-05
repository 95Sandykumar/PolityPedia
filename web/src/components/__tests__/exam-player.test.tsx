/**
 * The timed exam player, on screen (issue 18-exam-mode).
 *
 * What it has to prove:
 *
 *  * F-E5: NOTHING on screen names a right answer before submit. No option is
 *    coloured, no verdict is announced, and the teacher explanation is not in
 *    the markup at all, because it was never sent.
 *  * THE TIMER runs top right and turns amber under 5 minutes (DESIGN.md
 *    section 8), and hits 00:00 by itself.
 *  * D2: tapping the PROGRESS BAR opens a question-number grid with the three
 *    states (answered, marked, not seen), and tapping a number jumps there.
 *  * SUBMIT is the server's job: the score on screen is the number the route
 *    handed back, never one worked out here.
 *  * THE REVIEW is a RE-READ. After submit the player asks the route again and
 *    draws the key it is given, so the key really did arrive after submit.
 *
 * The client is a fake, so there is no network call and no key here
 * (web/CLAUDE.md).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExamPlayer } from '../exam-player';
import type { AttemptAnswer } from '@/lib/attempts/types';
import type { BrowserExamClient, ExamAnswer, ExamLoad } from '@/lib/exam/types';
import { stripAnswerKey } from '@/lib/exam/types';
import { markingOf } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';

/** CUET PG, from the 0004 seed. */
const CUET = markingOf({ marksCorrect: 4, marksWrong: -1 });

const OPTIONS: QuestionOptions = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];

const START = Date.parse('2026-11-05T10:00:00.000Z');

function question(number: number, correctIdx: number): Question {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${number}`,
    teacherId: TEACHER,
    paperId: null,
    testId: TEST,
    number,
    stem: `Question ${number}`,
    options: OPTIONS,
    correctIdx,
    teacherExplanation: `Because of Article 8${number}.`,
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'live',
  };
}

const PAPER = [question(1, 0), question(2, 1), question(3, 2)];
/** What the route actually sends while the sitting is open. */
const STRIPPED = PAPER.map(stripAnswerKey);

function fakeClient(over: Partial<BrowserExamClient> = {}) {
  const saved: ExamAnswer[] = [];
  const submitted: string[] = [];
  const client: BrowserExamClient = {
    saveAnswer: async (one) => {
      saved.push(one);
    },
    submit: async (id) => {
      submitted.push(id);
      return 7;
    },
    load: async (): Promise<ExamLoad> => ({
      questions: PAPER,
      attempt: {
        id: ATTEMPT,
        userId: 'u',
        paperId: null,
        testId: TEST,
        mode: 'exam',
        topicId: null,
        deadlineAt: null,
        submittedAt: '2026-11-05T10:30:00.000Z',
        score: 7,
      },
      answers: [],
      marking: CUET,
      heading: '',
      durationMin: 90,
      revealed: true,
    }),
    ...over,
  };
  return { client, saved, submitted };
}

/**
 * The default deadline is 90 minutes from WHATEVER the clock says now, so a
 * test that is not about the timer never accidentally opens a paper whose time
 * is already up (which would auto-submit under it).
 */
function draw(
  over: Partial<Parameters<typeof ExamPlayer>[0]> = {},
  client = fakeClient().client,
) {
  return render(
    <ExamPlayer
      questions={STRIPPED}
      attemptId={ATTEMPT}
      deadlineAt={new Date(Date.now() + 90 * 60 * 1000).toISOString()}
      mode="en"
      marking={CUET}
      client={client}
      now={() => Date.now()}
      {...over}
    />,
  );
}

const options = () => screen.getAllByTestId('exam-option');
const timer = () => screen.getByTestId('exam-timer');
const progress = () => screen.getByTestId('exam-progress-open');

// --------------------------------------------------------------------------
// F-E5: no answer key on the phone
// --------------------------------------------------------------------------
describe('before submit', () => {
  it('shows no right answer and no explanation anywhere', () => {
    const { container } = draw();

    fireEvent.click(options()[1]);

    expect(container.innerHTML).not.toContain('Article 8');
    expect(screen.queryByTestId('exam-review')).toBeNull();
    for (const option of options()) {
      // The only state an option can be in is chosen or not chosen.
      expect(['idle', 'chosen']).toContain(option.getAttribute('data-state'));
    }
  });

  it('says so out loud, so a student is not left wondering', () => {
    draw();

    expect(screen.getByText('Answers show after you submit')).toBeTruthy();
  });

  it('marks the chosen option, which is all the feedback there is', () => {
    draw();

    fireEvent.click(options()[2]);

    expect(options()[2].getAttribute('data-state')).toBe('chosen');
    expect(options()[0].getAttribute('data-state')).toBe('idle');
  });

  it('sends the answer with no verdict field at all', () => {
    const { client, saved } = fakeClient();
    draw({}, client);

    fireEvent.click(options()[3]);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      attemptId: ATTEMPT,
      questionId: PAPER[0].id,
      chosenIdx: 3,
      marked: false,
    });
    expect(saved[0]).not.toHaveProperty('isCorrect');
  });

  it('keeps taking answers when the network drops, never crashing the paper', () => {
    const { client } = fakeClient({
      saveAnswer: async () => {
        throw new Error('offline');
      },
    });
    draw({}, client);

    fireEvent.click(options()[1]);

    expect(options()[1].getAttribute('data-state')).toBe('chosen');
  });
});

// --------------------------------------------------------------------------
// The timer (DESIGN.md section 8)
// --------------------------------------------------------------------------
describe('the timer', () => {
  // ONLY this block runs on a fake clock. `waitFor` polls with timers, so a
  // fake clock in the submit tests would hang them.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the time left on the deadline', () => {
    draw();

    expect(timer().textContent).toContain('1:30:00');
    expect(timer().getAttribute('data-tone')).toBe('calm');
  });

  it('counts down on its own', () => {
    draw();

    act(() => {
      vi.advanceTimersByTime(65_000);
    });

    expect(timer().textContent).toContain('1:28:55');
  });

  it('turns amber under 5 minutes', () => {
    draw({ deadlineAt: new Date(START + 5 * 60 * 1000 + 1000).toISOString() });
    expect(timer().getAttribute('data-tone')).toBe('calm');

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(timer().getAttribute('data-tone')).toBe('amber');
    expect(timer().textContent).toContain('04:59');
  });

  it('stops at 00:00 and says the time is up', () => {
    draw({ deadlineAt: new Date(START + 2000).toISOString() });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(timer().textContent).toContain('00:00');
    expect(timer().getAttribute('data-tone')).toBe('over');
  });

  it('submits by itself when the clock runs out, because the writes stop too', async () => {
    const { client, submitted } = fakeClient();
    draw({ deadlineAt: new Date(START + 2000).toISOString() }, client);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(submitted).toEqual([ATTEMPT]);
  });

  it('is not drawn at all when there is no deadline', () => {
    draw({ deadlineAt: null });

    expect(screen.queryByTestId('exam-timer')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// D2: the question-number grid
// --------------------------------------------------------------------------
describe('the question grid', () => {
  it('is closed until the progress bar is tapped', () => {
    draw();
    expect(screen.queryByTestId('exam-grid')).toBeNull();

    fireEvent.click(progress());

    expect(screen.getByTestId('exam-grid')).toBeTruthy();
  });

  it('shows one square per question, with the three states', () => {
    const started: [string, AttemptAnswer][] = [
      [PAPER[0].id, { chosenIdx: 1, isCorrect: null, marked: false }],
      [PAPER[2].id, { chosenIdx: null, isCorrect: null, marked: true }],
    ];
    draw({ startedAnswers: started });

    fireEvent.click(progress());
    const squares = screen.getAllByTestId('exam-grid-square');

    expect(squares).toHaveLength(3);
    expect(squares[0].getAttribute('data-state')).toBe('answered');
    expect(squares[1].getAttribute('data-state')).toBe('unseen');
    expect(squares[2].getAttribute('data-state')).toBe('marked');
  });

  it('jumps to the question that was tapped, and closes', () => {
    draw();

    fireEvent.click(progress());
    fireEvent.click(screen.getAllByTestId('exam-grid-square')[2]);

    expect(screen.getByTestId('exam-progress')).toHaveTextContent('3 / 3');
    expect(screen.queryByTestId('exam-grid')).toBeNull();
  });

  it('can be closed without moving', () => {
    draw();

    fireEvent.click(progress());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByTestId('exam-grid')).toBeNull();
    expect(screen.getByTestId('exam-progress')).toHaveTextContent('1 / 3');
  });

  it('moves a question into marked when Mark for later is tapped', () => {
    draw();

    fireEvent.click(screen.getByTestId('exam-mark'));
    fireEvent.click(progress());

    expect(screen.getAllByTestId('exam-grid-square')[0].getAttribute('data-state')).toBe(
      'marked',
    );
  });
});

// --------------------------------------------------------------------------
// Submit, and the review that follows it
// --------------------------------------------------------------------------
describe('submit', () => {
  it('shows the score the SERVER worked out, not one counted here', async () => {
    const { client, submitted } = fakeClient();
    draw({}, client);

    // 1 right out of 3 at +4 would be 4 if the browser were marking. The fake
    // server says 7, and 7 is what has to be on screen.
    fireEvent.click(options()[0]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('exam-submit'));
    });

    expect(submitted).toEqual([ATTEMPT]);
    await waitFor(() => expect(screen.getByTestId('exam-score')).toHaveTextContent('7'));
  });

  it('re-reads the route, and only THEN shows the answers (F-E5)', async () => {
    const { client } = fakeClient();
    const { container } = draw({}, client);

    expect(container.innerHTML).not.toContain('Article 81');

    await act(async () => {
      fireEvent.click(screen.getByTestId('exam-submit'));
    });

    await waitFor(() => expect(screen.getByTestId('exam-review')).toBeTruthy());
    expect(container.innerHTML).toContain('Article 81');
  });

  it('colours the right and the chosen option in the review', async () => {
    const { client } = fakeClient();
    draw({}, client);

    // Question 1's right answer is option 0; choose option 2 instead.
    fireEvent.click(options()[2]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('exam-submit'));
    });

    await waitFor(() => expect(screen.getByTestId('exam-review')).toBeTruthy());
    expect(options()[0].getAttribute('data-state')).toBe('right');
    expect(options()[2].getAttribute('data-state')).toBe('wrong');
  });

  it('takes no more answers once the paper is in', async () => {
    const { client, saved } = fakeClient();
    draw({}, client);

    await act(async () => {
      fireEvent.click(screen.getByTestId('exam-submit'));
    });
    await waitFor(() => expect(screen.getByTestId('exam-score')).toBeTruthy());

    fireEvent.click(options()[1]);

    expect(saved).toHaveLength(0);
  });

  it('submits once, however many times the button is tapped', async () => {
    const { client, submitted } = fakeClient();
    draw({}, client);

    await act(async () => {
      const button = screen.getByTestId('exam-submit');
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByTestId('exam-score')).toBeTruthy());

    expect(submitted).toEqual([ATTEMPT]);
  });

  it('says so and lets the student try again when the submit fails', async () => {
    const { client } = fakeClient({
      submit: async () => {
        throw new Error('offline');
      },
    });
    draw({}, client);

    await act(async () => {
      fireEvent.click(screen.getByTestId('exam-submit'));
    });

    await waitFor(() =>
      expect(screen.getByText('Could not submit. Try again.')).toBeTruthy(),
    );
    expect(screen.getByTestId('exam-submit')).toBeTruthy();
  });

  it('still shows the score when the review re-read fails', async () => {
    const { client } = fakeClient({ load: async () => null });
    draw({}, client);

    await act(async () => {
      fireEvent.click(screen.getByTestId('exam-submit'));
    });

    await waitFor(() => expect(screen.getByTestId('exam-score')).toHaveTextContent('7'));
    expect(screen.queryByTestId('exam-review')).toBeNull();
  });
});

describe('a sitting that was already submitted', () => {
  it('opens straight into the review, with the stored score', () => {
    draw({ questions: PAPER, revealed: true, score: 7, deadlineAt: null });

    expect(screen.getByTestId('exam-score')).toHaveTextContent('7');
    expect(screen.getByTestId('exam-review')).toBeTruthy();
    expect(screen.queryByTestId('exam-submit')).toBeNull();
  });
});

describe('an empty paper', () => {
  it('says there are no questions rather than drawing an empty clock', () => {
    draw({ questions: [] });

    expect(screen.getByRole('status')).toHaveTextContent('No questions yet');
  });
});
