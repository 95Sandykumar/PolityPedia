/**
 * The exam player on a bad network (issue 58-exam-answer-queue).
 *
 * Walk persona-3, gap 3, steps 12 and 13: a student sits a timed paper on a
 * phone whose signal drops. Before this slice the player fired one `fetch` per
 * tap and swallowed the failure, so the paper looked fine and the score came
 * back short.
 *
 * What this file has to prove:
 *
 *  * AN ANSWER THE NETWORK REFUSED IS KEPT, and goes when the net comes back,
 *    in order and exactly once.
 *  * THE OFFLINE BAR says the answers are kept on this phone.
 *  * AN UNSENT ANSWER CARRIES A "SAVING" MARK, so the student can see which
 *    one is not in yet.
 *  * SUBMIT FLUSHES FIRST and REFUSES while answers are still held, naming how
 *    many. A paper closed early would be marked on fewer answers than were
 *    given.
 *  * A RELOAD RESTORES the held answers and sends them.
 *  * AUTO-SUBMIT RETRIES on the 10 second schedule, and stops when it works.
 *
 * The client is a fake and the storage is a Map, so there is no network call,
 * no key and no real `localStorage` here (web/CLAUDE.md).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExamPlayer } from '../exam-player';
import {
  createExamAnswerQueue,
  examQueueKey,
  type QueueStorage,
} from '@/lib/exam/exam-answer-queue';
import {
  stripAnswerKey,
  type BrowserExamClient,
  type ExamAnswer,
  type ExamAnswerQueue,
  type ExamLoad,
} from '@/lib/exam/types';
import { markingOf } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';

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
const STRIPPED = PAPER.map(stripAnswerKey);

/** A local storage in a Map, so a test can seed it and read it back. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage: QueueStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

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

function draw(
  over: Partial<Parameters<typeof ExamPlayer>[0]> = {},
  client: BrowserExamClient = fakeClient().client,
  queue?: ExamAnswerQueue,
) {
  return render(
    <ExamPlayer
      questions={STRIPPED}
      attemptId={ATTEMPT}
      deadlineAt={new Date(Date.now() + 90 * 60 * 1000).toISOString()}
      mode="en"
      marking={CUET}
      client={client}
      queue={queue}
      now={() => Date.now()}
      {...over}
    />,
  );
}

const options = () => screen.getAllByTestId('exam-option');

/** Tell the browser, and the player, that the net went away or came back. */
function setOnline(up: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: up,
  });
  window.dispatchEvent(new Event(up ? 'online' : 'offline'));
}

afterEach(() => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
});

// --------------------------------------------------------------------------
// The answer that could not be sent
// --------------------------------------------------------------------------
describe('an answer the network refused', () => {
  it('is kept, and goes in order when the net comes back', async () => {
    const sent: ExamAnswer[] = [];
    let up = false;
    const { client } = fakeClient({
      saveAnswer: async (one) => {
        if (!up) throw new Error('offline');
        sent.push(one);
      },
    });
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: (one) => client.saveAnswer(one),
    });

    draw({}, client, queue);

    // Question 1 answered, then question 2, both with the net down.
    fireEvent.click(options()[1]);
    await waitFor(() => expect(queue.pending()).toBe(1));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(options()[2]);
    await waitFor(() => expect(queue.pending()).toBe(2));

    expect(sent).toEqual([]);

    up = true;
    await act(async () => {
      setOnline(true);
    });

    await waitFor(() => expect(queue.pending()).toBe(0));
    expect(sent).toEqual([
      { attemptId: ATTEMPT, questionId: PAPER[0].id, chosenIdx: 1, marked: false },
      { attemptId: ATTEMPT, questionId: PAPER[1].id, chosenIdx: 2, marked: false },
    ]);
  });

  it('carries a saving mark until the server has it', async () => {
    let up = false;
    const { client } = fakeClient({
      saveAnswer: async () => {
        if (!up) throw new Error('offline');
      },
    });
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: (one) => client.saveAnswer(one),
    });

    draw({}, client, queue);
    expect(screen.queryByTestId('exam-saving')).toBeNull();

    fireEvent.click(options()[1]);

    await waitFor(() => expect(screen.getByTestId('exam-saving')).toBeTruthy());
    expect(screen.getByTestId('exam-saving')).toHaveTextContent('Saving');

    up = true;
    await act(async () => {
      await queue.flush();
    });

    await waitFor(() => expect(screen.queryByTestId('exam-saving')).toBeNull());
  });
});

// --------------------------------------------------------------------------
// The offline bar
// --------------------------------------------------------------------------
describe('the offline bar', () => {
  it('says the answers are kept on this phone', async () => {
    draw();
    expect(screen.queryByTestId('exam-offline')).toBeNull();

    await act(async () => {
      setOnline(false);
    });

    expect(screen.getByTestId('exam-offline')).toHaveTextContent('kept on this phone');

    await act(async () => {
      setOnline(true);
    });
    expect(screen.queryByTestId('exam-offline')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Submit flushes first
// --------------------------------------------------------------------------
describe('submit', () => {
  it('refuses while answers are still held, and says how many', async () => {
    const { client, submitted } = fakeClient({
      saveAnswer: async () => {
        throw new Error('offline');
      },
    });
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: (one) => client.saveAnswer(one),
    });

    draw({}, client, queue);

    fireEvent.click(options()[1]);
    await waitFor(() => expect(queue.pending()).toBe(1));

    fireEvent.click(screen.getByTestId('exam-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('exam-save-failed')).toHaveTextContent(
        'Could not save 1 answer. Try again.',
      ),
    );
    // The paper is NOT closed: the server would have marked it on nothing.
    expect(submitted).toEqual([]);
    expect(screen.queryByTestId('exam-score')).toBeNull();
    // The Submit button is still there for the next try.
    expect(screen.getByTestId('exam-submit')).toBeTruthy();
  });

  it('counts the held answers in the message', async () => {
    const { client } = fakeClient({
      saveAnswer: async () => {
        throw new Error('offline');
      },
    });
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: (one) => client.saveAnswer(one),
    });

    draw({}, client, queue);

    fireEvent.click(options()[1]);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(options()[2]);
    await waitFor(() => expect(queue.pending()).toBe(2));

    fireEvent.click(screen.getByTestId('exam-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('exam-save-failed')).toHaveTextContent(
        'Could not save 2 answers. Try again.',
      ),
    );
  });

  it('sends the held answer first, then closes the paper', async () => {
    const sent: ExamAnswer[] = [];
    let up = false;
    const { client, submitted } = fakeClient({
      saveAnswer: async (one) => {
        if (!up) throw new Error('offline');
        sent.push(one);
      },
    });
    const { storage } = fakeStorage();
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: (one) => client.saveAnswer(one),
    });

    draw({}, client, queue);

    fireEvent.click(options()[1]);
    await waitFor(() => expect(queue.pending()).toBe(1));

    // The net is back by the time the student taps Submit.
    up = true;
    fireEvent.click(screen.getByTestId('exam-submit'));

    await waitFor(() => expect(submitted).toEqual([ATTEMPT]));
    // The answer went BEFORE the submit, which is the whole point.
    expect(sent).toHaveLength(1);
    expect(queue.pending()).toBe(0);
    expect(screen.queryByTestId('exam-save-failed')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// The reload
// --------------------------------------------------------------------------
describe('a reload', () => {
  it('restores what was held and sends it on mount', async () => {
    const sent: ExamAnswer[] = [];
    const { client } = fakeClient({
      saveAnswer: async (one) => {
        sent.push(one);
      },
    });
    const { storage } = fakeStorage({
      [examQueueKey(ATTEMPT)]: JSON.stringify([
        { attemptId: ATTEMPT, questionId: PAPER[0].id, chosenIdx: 3, marked: false },
      ]),
    });
    const queue = createExamAnswerQueue({
      attemptId: ATTEMPT,
      storage,
      save: (one) => client.saveAnswer(one),
    });

    expect(queue.pending()).toBe(1);

    draw({}, client, queue);

    await waitFor(() => expect(queue.pending()).toBe(0));
    expect(sent).toEqual([
      { attemptId: ATTEMPT, questionId: PAPER[0].id, chosenIdx: 3, marked: false },
    ]);
  });
});

// --------------------------------------------------------------------------
// Auto-submit, on a 10 second schedule (B6)
// --------------------------------------------------------------------------
describe('auto-submit at the deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tries again every 10 seconds until it works, then stops', async () => {
    const tries: string[] = [];
    let up = false;
    const { client } = fakeClient({
      submit: async (id) => {
        tries.push(id);
        if (!up) throw new Error('offline');
        return 7;
      },
    });

    // The clock has already run out, so auto-submit fires on mount.
    await act(async () => {
      draw({ deadlineAt: new Date(START - 1000).toISOString() }, client);
    });

    expect(tries).toHaveLength(1);
    expect(screen.getByTestId('exam-submit')).toBeTruthy();

    // Still down: one more try, and only one, per 10 seconds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(tries).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(tries).toHaveLength(2);

    up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(tries).toHaveLength(3);
    expect(screen.queryByTestId('exam-submit')).toBeNull();

    // It worked, so it stops. No request for ever on a closed paper.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(tries).toHaveLength(3);
  });

  it('stops when the player goes away, so an unmount leaves no timer', async () => {
    const tries: string[] = [];
    const { client } = fakeClient({
      submit: async (id) => {
        tries.push(id);
        throw new Error('offline');
      },
    });

    let view: ReturnType<typeof draw> | null = null;
    await act(async () => {
      view = draw({ deadlineAt: new Date(START - 1000).toISOString() }, client);
    });
    expect(tries).toHaveLength(1);

    await act(async () => {
      view?.unmount();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(tries).toHaveLength(1);
  });
});
