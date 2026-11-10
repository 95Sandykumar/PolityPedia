/**
 * The result page inside the exam player (issue 56-result-page).
 *
 * The player's own test (`exam-player.test.tsx`) proves the key arrives only
 * after submit. This one proves what happens NEXT, which until this slice was
 * one line of text:
 *
 *  * The result read is asked AFTER the close, never before, and asked ONCE.
 *  * Its answer REPLACES the one-line score. Never both at once, so there is
 *    no screen with two marks on it.
 *  * The score on the page is the one the READ returned, which is the number
 *    `score_attempt()` stored (0031), not the one the browser could count from
 *    the answers on screen.
 *  * The deadline auto-submit shows the same page, and says the clock did it.
 *  * A read that answers null leaves the one-line score standing: the student
 *    still sees the mark the submit handed back.
 *
 * The client and the read are both fakes, so there is no network here.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExamPlayer } from '../exam-player';
import type { AttemptResult } from '@/lib/attempts/types';
import type { BrowserExamClient, ExamAnswer, ExamLoad } from '@/lib/exam/types';
import { stripAnswerKey } from '@/lib/exam/types';
import { markingOf } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';

/** CUET PG, from the 0004 seed: +4 a right answer, so 3 questions are 12. */
const CUET = markingOf({ marksCorrect: 4, marksWrong: -1 });

const OPTIONS: QuestionOptions = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];

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

/** What the server read gives back for this sitting. */
function serverResult(over: Partial<AttemptResult> = {}): AttemptResult {
  return {
    attemptId: ATTEMPT,
    mode: 'exam',
    score: 7,
    total: 3,
    percent: 67,
    right: 2,
    wrong: 1,
    skipped: 0,
    timeTakenSec: 185,
    autoSubmitted: false,
    wrongQuestions: [
      {
        questionId: PAPER[1].id,
        number: 2,
        stem: 'Question 2',
        chosen: { idx: 3, letter: 'D', text: 'Neither' },
        right: { idx: 1, letter: 'B', text: 'Rajya Sabha' },
      },
    ],
    ...over,
  };
}

function fakeClient(): BrowserExamClient {
  const saved: ExamAnswer[] = [];
  return {
    saveAnswer: async (one) => {
      saved.push(one);
    },
    // The server's number, which the player must not second-guess.
    submit: async () => 7,
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
        submittedAt: '2026-11-09T10:30:00.000Z',
        score: 7,
      },
      answers: [],
      marking: CUET,
      heading: 'Mock 1',
      durationMin: 90,
      revealed: true,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ExamPlayer, the result page', () => {
  it('asks for nothing while the sitting is open', () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <ExamPlayer
        questions={STRIPPED}
        attemptId={ATTEMPT}
        deadlineAt={null}
        mode="en"
        marking={CUET}
        readResult={readResult}
        client={fakeClient()}
      />,
    );

    // 0030: a result exists only after the close, so the read is not even made.
    expect(readResult).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attempt-result')).toBeNull();
  });

  it('replaces the one-line score with the result page after Submit', async () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <ExamPlayer
        questions={STRIPPED}
        attemptId={ATTEMPT}
        deadlineAt={null}
        mode="en"
        marking={CUET}
        readResult={readResult}
        nextHref={`/t/${TEACHER}/mocks`}
        client={fakeClient()}
      />,
    );

    fireEvent.click(screen.getByTestId('exam-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
    });

    expect(readResult).toHaveBeenCalledTimes(1);
    expect(readResult).toHaveBeenCalledWith(ATTEMPT);

    // The mark from the READ, out of the marks the paper carries: 3 at +4.
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('7 / 12');
    expect(screen.getByTestId('attempt-result-right')).toHaveTextContent('2');
    expect(screen.getByTestId('attempt-result-wrong-row')).toHaveTextContent('Rajya Sabha');
    expect(screen.getByTestId('attempt-result-next')).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks`,
    );

    // One mark on screen, not two.
    expect(screen.queryByTestId('exam-score')).toBeNull();
  });

  it('keeps the one-line score when the result read answers null', async () => {
    const readResult = vi.fn(async () => null);

    render(
      <ExamPlayer
        questions={STRIPPED}
        attemptId={ATTEMPT}
        deadlineAt={null}
        mode="en"
        marking={CUET}
        readResult={readResult}
        client={fakeClient()}
      />,
    );

    fireEvent.click(screen.getByTestId('exam-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('exam-score')).toBeInTheDocument();
    });
    // The server's 7, out of 12. The student is never left with no mark.
    expect(screen.getByTestId('exam-score')).toHaveTextContent('7 / 12');
    expect(screen.queryByTestId('attempt-result')).toBeNull();
    // Asked once, and never again: null is an answer, not a reason to retry.
    expect(readResult).toHaveBeenCalledTimes(1);
  });

  it('shows the result page of a sitting that was already submitted', async () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <ExamPlayer
        questions={PAPER}
        attemptId={ATTEMPT}
        deadlineAt={null}
        mode="en"
        marking={CUET}
        revealed
        score={7}
        readResult={readResult}
        client={fakeClient()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
    });
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('7 / 12');
  });

  /**
   * The dev-mode remount (ticket 56b).
   *
   * React's StrictMode mounts, unmounts and mounts again in development, so
   * every effect runs twice. The "ask once" latch is a ref, and a ref SURVIVES
   * that remount: without a reset in the cleanup the second mount reads the
   * latch as already asked and the student is left staring at no result page
   * for the whole dev session.
   *
   * So the cleanup clears the latch. The cost is a second read in development
   * only; the gain is that what the developer sees is what the student sees.
   */
  it('still shows the result page on a StrictMode remount', async () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <StrictMode>
        <ExamPlayer
          questions={STRIPPED}
          attemptId={ATTEMPT}
          deadlineAt={null}
          mode="en"
          marking={CUET}
          readResult={readResult}
          client={fakeClient()}
        />
      </StrictMode>,
    );

    fireEvent.click(screen.getByTestId('exam-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
    });

    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('7 / 12');
    expect(screen.queryByTestId('exam-score')).toBeNull();
  });

  /**
   * The same remount, for a sitting that was ALREADY closed when the page
   * opened. This is the case the latch actually broke: the first mount asks,
   * the cleanup throws its answer away (`alive` is false), and a latch that
   * survived would make the second mount skip the ask for ever.
   */
  it('still shows the result page of an already submitted sitting on a StrictMode remount', async () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <StrictMode>
        <ExamPlayer
          questions={PAPER}
          attemptId={ATTEMPT}
          deadlineAt={null}
          mode="en"
          marking={CUET}
          revealed
          score={7}
          readResult={readResult}
          client={fakeClient()}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
    });
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('7 / 12');
  });

  describe('at the deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('shows the same page for a partly finished sitting the clock closed', async () => {
      const start = Date.parse('2026-11-09T10:00:00.000Z');
      vi.setSystemTime(start);

      // Two questions never touched: a partly finished paper (0 right, 1
      // wrong, 2 skipped), and the clock is what closed it.
      const readResult = vi.fn(async () =>
        serverResult({
          score: -1,
          right: 0,
          wrong: 1,
          skipped: 2,
          percent: 0,
          autoSubmitted: true,
        }),
      );

      render(
        <ExamPlayer
          questions={STRIPPED}
          attemptId={ATTEMPT}
          deadlineAt={new Date(start + 2000).toISOString()}
          mode="en"
          marking={CUET}
          readResult={readResult}
          client={fakeClient()}
        />,
      );

      // Let the clock run out: the player submits by itself.
      await act(async () => {
        vi.setSystemTime(start + 3000);
        await vi.advanceTimersByTimeAsync(1200);
      });

      await waitFor(() => {
        expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
      });

      expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('-1 / 12');
      expect(screen.getByTestId('attempt-result-skipped')).toHaveTextContent('2');
      // The clock closed it, and the page says so.
      expect(screen.getByTestId('attempt-result-auto')).toBeInTheDocument();
      expect(screen.queryByTestId('exam-score')).toBeNull();
    });
  });
});
