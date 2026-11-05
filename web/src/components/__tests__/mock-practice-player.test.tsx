/**
 * Practice mode for a mock test, on screen (issue 17-practice-mode).
 *
 * The player component is SHARED with past papers (issue 13). What this slice
 * adds to it is F-E6: the score is the exam's MARKS, not a count of right
 * answers. So this file drives the same player with a marking scheme and reads
 * the score line.
 *
 * CUET PG is +4 and -1 (the 0004 seed). One right and one wrong is 3 out of 8,
 * never 1 out of 2.
 *
 * The queue is a fake, so there is no network call and no key here
 * (web/CLAUDE.md).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPlayer } from '../question-player';
import type { AnswerQueue, AnswerUpsert } from '@/lib/attempts/types';
import { markingOf } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';

/** CUET PG, from the 0004 seed. */
const CUET = markingOf({ marksCorrect: 4, marksWrong: -1 });

const OPTIONS: QuestionOptions = ['A one', 'B two', 'C three', 'D four'];

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
    teacherExplanation: null,
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'live',
  };
}

function fakeQueue() {
  const sent: AnswerUpsert[] = [];
  const queue: AnswerQueue = {
    push: async (one) => {
      sent.push(one);
    },
    flush: async () => {},
    pending: () => 0,
    subscribe: () => () => {},
  };
  return { queue, sent };
}

const options = () => screen.getAllByTestId('player-option');
const next = () => screen.getByRole('button', { name: /Next/ });
const finish = () => screen.getByRole('button', { name: 'Finish' });

describe('a mock test in practice mode', () => {
  it('scores with marks_correct and marks_wrong, not a count of right answers', () => {
    const onFinish = vi.fn();
    const { queue } = fakeQueue();

    render(
      <QuestionPlayer
        questions={[question(1, 0), question(2, 0)]}
        attemptId={ATTEMPT}
        queue={queue}
        marking={CUET}
        onFinish={onFinish}
      />,
    );

    // Question 1: right (+4).
    fireEvent.click(options()[0]);
    fireEvent.click(next());
    // Question 2: wrong (-1).
    fireEvent.click(options()[1]);
    fireEvent.click(finish());

    expect(screen.getByTestId('player-score')).toHaveTextContent('3 / 8');
    expect(onFinish).toHaveBeenCalledWith(3);
  });

  it('shows the result on the same screen, the way practice means (D3)', () => {
    const { queue } = fakeQueue();
    render(
      <QuestionPlayer
        questions={[question(1, 0)]}
        attemptId={ATTEMPT}
        queue={queue}
        marking={CUET}
      />,
    );

    expect(screen.queryByTestId('player-result')).not.toBeInTheDocument();
    fireEvent.click(options()[1]);
    // No page load, no timer: the verdict is under the options at once.
    expect(screen.getByTestId('player-result')).toHaveTextContent('Wrong');
  });

  it('counts right answers when the exam has no marking scheme yet', () => {
    const onFinish = vi.fn();
    const { queue } = fakeQueue();

    render(
      <QuestionPlayer
        questions={[question(1, 0), question(2, 0)]}
        attemptId={ATTEMPT}
        queue={queue}
        // PGT and TGT: marking unknown (PRD section 6).
        marking={markingOf({ marksCorrect: null, marksWrong: null })}
        onFinish={onFinish}
      />,
    );

    fireEvent.click(options()[0]);
    fireEvent.click(next());
    fireEvent.click(options()[1]);
    fireEvent.click(finish());

    expect(screen.getByTestId('player-score')).toHaveTextContent('1 / 2');
    expect(onFinish).toHaveBeenCalledWith(1);
  });

  it('writes every answer through the queue, keyed by attempt and question', () => {
    const { queue, sent } = fakeQueue();
    render(
      <QuestionPlayer
        questions={[question(1, 0)]}
        attemptId={ATTEMPT}
        queue={queue}
        marking={CUET}
      />,
    );

    fireEvent.click(options()[0]);

    expect(sent).toEqual([
      {
        attemptId: ATTEMPT,
        questionId: question(1, 0).id,
        chosenIdx: 0,
        isCorrect: true,
        marked: false,
      },
    ]);
  });
});
