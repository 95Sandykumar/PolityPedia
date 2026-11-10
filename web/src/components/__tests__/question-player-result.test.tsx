/**
 * The result page inside the PRACTICE player (ticket 56b).
 *
 * Ticket 56 put `AttemptResultPanel` into exam mode only, so a student who
 * finished a past paper or a practice sitting still got the one-line browser
 * score. That is the screen this slice replaces, and the rules are the exam
 * player's rules, because it is the same panel and the same reader:
 *
 *  * NOTHING is asked before Finish: there is no result until the sitting is
 *    closed (0030).
 *  * The answer REPLACES the one-line score. Never two marks on one screen.
 *  * The mark on the panel is the number the READ returned, which is what
 *    `score_attempt()` stored (0031), not the number this component counted.
 *    The fixture below returns a score that DISAGREES with the answers on
 *    screen on purpose.
 *  * "Next test" goes where the page above says, and nowhere else.
 *  * A read that answers null leaves the one-line score standing.
 *  * React's StrictMode remount still ends with the panel on screen.
 *
 * The queue and the read are both fakes, so there is no network call and no
 * key here (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPlayer } from '../question-player';
import type { AnswerQueue, AnswerUpsert, AttemptResult } from '@/lib/attempts/types';
import { markingOf } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const PAPER_ID = '33333333-3333-4333-8333-333333333333';

/** One mark a question, no negative marking: what a past paper gets. */
const PLAIN = markingOf({ marksCorrect: null, marksWrong: null });

const OPTIONS: QuestionOptions = ['A one', 'B two', 'C three', 'D four'];

function question(number: number, correctIdx: number): Question {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${number}`,
    teacherId: TEACHER,
    paperId: PAPER_ID,
    testId: null,
    number,
    stem: `Question ${number}`,
    options: OPTIONS,
    correctIdx,
    teacherExplanation: null,
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'live',
  };
}

const PAPER = [question(1, 0), question(2, 0), question(3, 0)];

/**
 * What the server read gives back. Three questions, one right, one wrong and
 * one never opened, and a STORED score of 2 that the browser could not have
 * worked out from those answers (a moderated question, 0031).
 */
function serverResult(over: Partial<AttemptResult> = {}): AttemptResult {
  return {
    attemptId: ATTEMPT,
    mode: 'practice',
    score: 2,
    total: 3,
    percent: 67,
    right: 1,
    wrong: 1,
    skipped: 1,
    timeTakenSec: 95,
    autoSubmitted: false,
    wrongQuestions: [
      {
        questionId: PAPER[1].id,
        number: 2,
        stem: 'Question 2',
        chosen: { idx: 1, letter: 'B', text: 'B two' },
        right: { idx: 0, letter: 'A', text: 'A one' },
      },
    ],
    ...over,
  };
}

function fakeQueue(): AnswerQueue {
  const sent: AnswerUpsert[] = [];
  return {
    push: async (one) => {
      sent.push(one);
    },
    flush: async () => {},
    pending: () => 0,
    subscribe: () => () => {},
  };
}

const options = () => screen.getAllByTestId('player-option');
const next = () => screen.getByRole('button', { name: /Next/ });
const finish = () => screen.getByRole('button', { name: 'Finish' });

/** Answer question 1 right, question 2 wrong, skip question 3, then Finish. */
function playAndFinish(): void {
  fireEvent.click(options()[0]);
  fireEvent.click(next());
  fireEvent.click(options()[1]);
  fireEvent.click(next());
  fireEvent.click(finish());
}

describe('QuestionPlayer, the result page', () => {
  it('asks for nothing while the sitting is still open', () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <QuestionPlayer
        questions={PAPER}
        attemptId={ATTEMPT}
        queue={fakeQueue()}
        marking={PLAIN}
        readResult={readResult}
      />,
    );

    fireEvent.click(options()[0]);
    expect(readResult).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attempt-result')).toBeNull();
  });

  it('replaces the one-line score with the result page after Finish', async () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <QuestionPlayer
        questions={PAPER}
        attemptId={ATTEMPT}
        queue={fakeQueue()}
        marking={PLAIN}
        readResult={readResult}
        nextHref={`/t/${TEACHER}/papers`}
      />,
    );

    playAndFinish();

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
    });

    expect(readResult).toHaveBeenCalledTimes(1);
    expect(readResult).toHaveBeenCalledWith(ATTEMPT);

    // The STORED mark, out of the marks the paper carries. Not the 1 this
    // component would have counted from the two answers on screen (0031).
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('2 / 3');

    // Right + wrong + skipped is the question total, always.
    expect(screen.getByTestId('attempt-result-right')).toHaveTextContent('1');
    expect(screen.getByTestId('attempt-result-wrong')).toHaveTextContent('1');
    expect(screen.getByTestId('attempt-result-skipped')).toHaveTextContent('1');

    // One mark on screen, not two: the old one-line score is gone.
    expect(screen.queryByTestId('player-score')).toBeNull();
  });

  it('sends "Next test" where the page above says', async () => {
    render(
      <QuestionPlayer
        questions={PAPER}
        attemptId={ATTEMPT}
        queue={fakeQueue()}
        marking={PLAIN}
        readResult={async () => serverResult()}
        nextHref={`/t/${TEACHER}/papers`}
      />,
    );

    playAndFinish();

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result-next')).toBeInTheDocument();
    });
    expect(screen.getByTestId('attempt-result-next')).toHaveAttribute(
      'href',
      `/t/${TEACHER}/papers`,
    );
    // B3: no viewport prefetch on our links.
    expect(screen.getByTestId('attempt-result-next').getAttribute('prefetch')).toBeNull();
  });

  it('keeps the one-line score when the result read answers null', async () => {
    const readResult = vi.fn(async () => null);

    render(
      <QuestionPlayer
        questions={PAPER}
        attemptId={ATTEMPT}
        queue={fakeQueue()}
        marking={PLAIN}
        readResult={readResult}
      />,
    );

    playAndFinish();

    await waitFor(() => {
      expect(readResult).toHaveBeenCalledTimes(1);
    });
    // The student is never left with no mark at all.
    expect(screen.getByTestId('player-score')).toHaveTextContent('1 / 3');
    expect(screen.queryByTestId('attempt-result')).toBeNull();
  });

  it('shows nothing new when the page above passes no reader', () => {
    render(
      <QuestionPlayer
        questions={PAPER}
        attemptId={ATTEMPT}
        queue={fakeQueue()}
        marking={PLAIN}
      />,
    );

    playAndFinish();
    // The old screen, unchanged: a page that cannot read a result still works.
    expect(screen.getByTestId('player-score')).toHaveTextContent('1 / 3');
    expect(screen.queryByTestId('attempt-result')).toBeNull();
  });

  it('still shows the result page on a StrictMode remount', async () => {
    const readResult = vi.fn(async () => serverResult());

    render(
      <StrictMode>
        <QuestionPlayer
          questions={PAPER}
          attemptId={ATTEMPT}
          queue={fakeQueue()}
          marking={PLAIN}
          readResult={readResult}
        />
      </StrictMode>,
    );

    playAndFinish();

    await waitFor(() => {
      expect(screen.getByTestId('attempt-result')).toBeInTheDocument();
    });
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('2 / 3');
  });
});
