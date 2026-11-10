/**
 * The review of a finished sitting, on screen (ticket 57-review-and-retake).
 *
 * Walk persona-1 gap 5 and persona-3 step 16: tapping "Review" on a test the
 * student had already finished opened a BLANK NEW SITTING, and in exam mode it
 * could start a new timed one. Every tap also left an `attempts` row behind.
 * This panel is the screen that replaces that, and the whole point of it is
 * what it does NOT do:
 *
 *  * IT IS READ ONLY. Every question is shown with the option the student
 *    picked, the right one and the teacher's prose, and there is no option
 *    button, no radio and no form on the page. A page view must not write
 *    data, so this component is handed an `AttemptReview` and holds no client,
 *    no queue and no `fetch`.
 *  * RETAKE IS A SEPARATE LINK. It is the only thing on the panel that starts
 *    a new sitting, it says so in words, and it is the only link here.
 *  * 0030 AND 0037 ARE STATES, NOT GAPS. `right: null` is the key lock and
 *    `explanation: null` is either no prose or the prose lock; a locked
 *    question is still listed, and the panel says which it is rather than
 *    drawing a letter nobody sent.
 *  * A SKIPPED QUESTION IS NOT A WRONG ONE. With `chosen: null` the panel says
 *    the question was skipped and never claims an answer for it.
 *
 * No network and no database here: the reader of 57a is what is proved against
 * real Postgres in `web/test/attempt-review.test.ts`.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttemptReviewPanel } from '../attempt-review';
import type { AttemptReview, ReviewQuestion } from '@/lib/attempts/types';
import { dictionary } from '@/lib/i18n';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const RETAKE = '/t/teacher-1/mocks/test-1/play?mode=practice';

const OPTIONS = [
  { idx: 0, letter: 'A', text: 'Lok Sabha only' },
  { idx: 1, letter: 'B', text: 'Rajya Sabha only' },
  { idx: 2, letter: 'C', text: 'Both Houses and the Assemblies' },
  { idx: 3, letter: 'D', text: 'The Supreme Court' },
];

function question(number: number, over: Partial<ReviewQuestion> = {}): ReviewQuestion {
  return {
    questionId: `aaaaaaaa-0000-4000-8000-00000000000${number}`,
    number,
    stem: `Question ${number}: who elects the President of India?`,
    options: OPTIONS,
    chosen: OPTIONS[2],
    right: OPTIONS[2],
    isCorrect: true,
    marked: false,
    explanation: `Article 54 names the electoral college. Question ${number}.`,
    ...over,
  };
}

function review(over: Partial<AttemptReview> = {}): AttemptReview {
  return {
    attemptId: ATTEMPT,
    mode: 'practice',
    score: 1,
    total: 3,
    percent: 33,
    right: 1,
    wrong: 1,
    skipped: 1,
    timeTakenSec: 754,
    autoSubmitted: false,
    questions: [
      question(1),
      question(2, { chosen: OPTIONS[1], right: OPTIONS[2], isCorrect: false }),
      question(3, { chosen: null, isCorrect: null, marked: true }),
    ],
    ...over,
  };
}

function draw(over: Partial<AttemptReview> = {}, retakeHref: string | null = RETAKE) {
  return render(
    <AttemptReviewPanel review={review(over)} mode="en" retakeHref={retakeHref} />,
  );
}

const cards = () => screen.getAllByTestId('attempt-review-question');

describe('AttemptReviewPanel', () => {
  it('lists EVERY question of the sitting, in paper order, with the whole stem', () => {
    draw();

    const shown = cards();
    expect(shown).toHaveLength(3);
    expect(shown[0]).toHaveTextContent('Question 1: who elects the President of India?');
    expect(shown[1]).toHaveTextContent('Question 2: who elects the President of India?');
    expect(shown[2]).toHaveTextContent('Question 3: who elects the President of India?');
  });

  it('shows all four options of a question, each with its letter', () => {
    draw();

    const first = within(cards()[0]);
    const rows = first.getAllByTestId('attempt-review-option');
    expect(rows).toHaveLength(4);
    // Read off the option rows and not off the card, because the answer the
    // student gave is named a second time underneath them.
    const shown = rows.map((row) => row.textContent ?? '');
    for (const one of OPTIONS) {
      expect(shown.some((text) => text.includes(one.letter) && text.includes(one.text))).toBe(
        true,
      );
    }
  });

  it('names the answer the student gave and the right one, in words', () => {
    draw();

    // The wrong one: B was picked, C is right, and both are named.
    const wrong = within(cards()[1]);
    expect(wrong.getByTestId('attempt-review-chosen')).toHaveTextContent('Rajya Sabha only');
    expect(wrong.getByTestId('attempt-review-chosen')).toHaveTextContent('Your answer');
    expect(wrong.getByTestId('attempt-review-right')).toHaveTextContent(
      'Both Houses and the Assemblies',
    );
    expect(wrong.getByTestId('attempt-review-right')).toHaveTextContent('Right answer');
  });

  it('shows the teacher explanation of every question', () => {
    draw();

    expect(
      screen.getByText('Article 54 names the electoral college. Question 1.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Article 54 names the electoral college. Question 2.'),
    ).toBeInTheDocument();
  });

  it('says a skipped question was skipped, and claims no answer for it', () => {
    draw();

    const skipped = within(cards()[2]);
    expect(skipped.getByTestId('attempt-review-skipped')).toHaveTextContent(
      dictionary.en['recap.skippedOne'],
    );
    expect(skipped.queryByTestId('attempt-review-chosen')).not.toBeInTheDocument();
    // It was marked for later during the sitting, and that is still worth saying.
    expect(skipped.getByText(dictionary.en['recap.marked'])).toBeInTheDocument();
  });

  it('says the key is locked rather than drawing a letter nobody sent (0030)', () => {
    draw({
      questions: [question(1, { right: null, isCorrect: null, explanation: null })],
    });

    const only = within(cards()[0]);
    expect(only.getByTestId('attempt-review-locked')).toHaveTextContent(
      dictionary.en['result.rightLocked'],
    );
    expect(only.queryByTestId('attempt-review-right')).not.toBeInTheDocument();
    // 0037: the prose is shut by the same open exam sitting.
    expect(only.getByTestId('attempt-review-explanation-locked')).toHaveTextContent(
      dictionary.en['recap.explanationLocked'],
    );
  });

  it('says there is no explanation when the key is open and the prose is missing', () => {
    draw({ questions: [question(1, { explanation: null })] });

    expect(screen.getByText(dictionary.en['player.noExplanation'])).toBeInTheDocument();
    expect(
      screen.queryByTestId('attempt-review-explanation-locked'),
    ).not.toBeInTheDocument();
  });

  it('writes nothing: no button, no radio, no form on the whole panel', () => {
    draw();

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('is told on screen that this is a finished sitting', () => {
    draw();
    expect(screen.getByTestId('attempt-review')).toHaveTextContent(
      dictionary.en['recap.readOnly'],
    );
  });

  it('gives Retake its own link, and it is the ONLY link on the panel', () => {
    draw();

    const retake = screen.getByRole('link', { name: dictionary.en['recap.retake'] });
    expect(retake).toHaveAttribute('href', RETAKE);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('draws no Retake link when the page above has nowhere to send them', () => {
    draw({}, null);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('shows the stored score and the counts, never ones worked out here', () => {
    // A moderated question: 1 right answer on screen, stored mark 7 (0031).
    draw({ score: 7, right: 1, wrong: 1, skipped: 1, percent: 33 });

    const summary = screen.getByTestId('attempt-review-summary');
    expect(summary).toHaveTextContent('7');
    expect(summary).toHaveTextContent('33%');
  });

  it('shows both languages in `both` mode', () => {
    render(
      <AttemptReviewPanel review={review()} mode="both" retakeHref={RETAKE} />,
    );

    expect(screen.getByText(dictionary.en['recap.retake'])).toBeInTheDocument();
    expect(screen.getByText(dictionary.hi['recap.retake'])).toBeInTheDocument();
  });
});
