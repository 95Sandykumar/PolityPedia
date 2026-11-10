/**
 * The result page of one submitted sitting, on screen (issue 56-result-page).
 *
 * The payoff moment of the whole journey used to be one line, "Score 12 / 20".
 * This panel is what replaces it, and the reader from ticket 56a already did
 * every piece of arithmetic on the server, so what this test has to prove is
 * that the SCREEN repeats the reader and invents nothing:
 *
 *  * 0031: the score on screen is `result.score`, the number `score_attempt()`
 *    STORED. The fixture here stores a score that DISAGREES with the right
 *    answers on purpose (a moderated question), and the panel still shows the
 *    stored one.
 *  * The counts add up. Right + wrong + skipped is the question total, and all
 *    four numbers are on screen, for an all-right, an all-wrong and a partly
 *    finished sitting alike.
 *  * 0030: a wrong question whose `right` is null (the key lock, F-E5: the
 *    student has the same test open in another tab) says the right answer is
 *    not available yet. No letter, no option text, nothing invented.
 *  * The deadline auto-submit is the same page, plus one line saying the clock
 *    closed it.
 *  * The Saved note counts the wrong answers, and the "Next test" link is
 *    prefetch-free (B3).
 *
 * No network and no database here: the panel is handed an `AttemptResult`,
 * exactly the shape `readAttemptResult()` returns, and the PGlite tests of
 * 56a (`web/test/attempt-result.test.ts`) are what prove RLS hides another
 * student's sitting.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttemptResultPanel } from '../attempt-result';
import type { AttemptResult, ResultWrongQuestion } from '@/lib/attempts/types';
import { dictionary } from '@/lib/i18n';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';

function wrongOne(number: number, over: Partial<ResultWrongQuestion> = {}): ResultWrongQuestion {
  return {
    questionId: `aaaaaaaa-0000-4000-8000-00000000000${number}`,
    number,
    stem: `Who elects the President of India? Question ${number}`,
    chosen: { idx: 1, letter: 'B', text: 'Rajya Sabha only' },
    right: { idx: 2, letter: 'C', text: 'Both Houses and the Assemblies' },
    ...over,
  };
}

function result(over: Partial<AttemptResult> = {}): AttemptResult {
  return {
    attemptId: ATTEMPT,
    mode: 'practice',
    score: 10,
    total: 20,
    percent: 50,
    right: 10,
    wrong: 6,
    skipped: 4,
    timeTakenSec: 754,
    autoSubmitted: false,
    wrongQuestions: [wrongOne(3), wrongOne(7)],
    ...over,
  };
}

describe('AttemptResultPanel', () => {
  it('shows the SERVER-stored score, never one worked out from the answers', () => {
    // A moderated question: 14 right answers, but the stored mark is 11. The
    // panel must show 11 (0031). `outOf` is the marks the paper carries (F-E6).
    render(
      <AttemptResultPanel
        result={result({ score: 11, right: 14, wrong: 6, skipped: 0, percent: 70 })}
        mode="en"
        outOf={20}
      />,
    );

    const score = screen.getByTestId('attempt-result-score');
    expect(score).toHaveTextContent('11');
    expect(score).toHaveTextContent('20');
    // 14 right at one mark each would have been 14. It is not on the score line.
    expect(score.textContent).not.toContain('14');
  });

  it('shows the score out of the question total when no marking is given', () => {
    render(<AttemptResultPanel result={result({ score: 10, total: 20 })} mode="en" />);
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('10 / 20');
  });

  it('shows percent, right, wrong and skipped, and the three counts add up', () => {
    const one = result();
    render(<AttemptResultPanel result={one} mode="en" outOf={20} />);

    expect(one.right + one.wrong + one.skipped).toBe(one.total);

    expect(screen.getByTestId('attempt-result-percent')).toHaveTextContent('50%');
    expect(screen.getByTestId('attempt-result-right')).toHaveTextContent('10');
    expect(screen.getByTestId('attempt-result-wrong')).toHaveTextContent('6');
    expect(screen.getByTestId('attempt-result-skipped')).toHaveTextContent('4');
  });

  it('shows the time taken as minutes and seconds', () => {
    render(<AttemptResultPanel result={result({ timeTakenSec: 754 })} mode="en" />);
    // 12 minutes 34 seconds.
    expect(screen.getByTestId('attempt-result-time')).toHaveTextContent('12:34');
  });

  it('shows the time taken with hours once a sitting runs past one', () => {
    render(<AttemptResultPanel result={result({ timeTakenSec: 3905 })} mode="en" />);
    // One hour, 5 minutes, 5 seconds.
    expect(screen.getByTestId('attempt-result-time')).toHaveTextContent('1:05:05');
  });

  it('lists every wrong question with the short stem, the answer given and the right one', () => {
    render(<AttemptResultPanel result={result()} mode="en" outOf={20} />);

    const rows = screen.getAllByTestId('attempt-result-wrong-row');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent('3');
    expect(rows[0]).toHaveTextContent('Who elects the President of India?');
    expect(rows[0]).toHaveTextContent('Rajya Sabha only');
    expect(rows[0]).toHaveTextContent('Both Houses and the Assemblies');
    expect(rows[0]).toHaveTextContent('B');
    expect(rows[0]).toHaveTextContent('C');
    expect(rows[1]).toHaveTextContent('7');
  });

  it('says the right answer is locked rather than inventing one (0030)', () => {
    render(
      <AttemptResultPanel
        result={result({ wrongQuestions: [wrongOne(3, { right: null })] })}
        mode="en"
      />,
    );

    const row = screen.getByTestId('attempt-result-wrong-row');
    expect(screen.getByTestId('attempt-result-locked')).toBeInTheDocument();
    // The answer the student gave is still there; no right answer is drawn.
    expect(row).toHaveTextContent('Rajya Sabha only');
    expect(row).not.toHaveTextContent('Both Houses and the Assemblies');
  });

  it('notes how many wrong answers went to Saved', () => {
    render(<AttemptResultPanel result={result({ wrong: 6 })} mode="en" />);
    expect(screen.getByTestId('attempt-result-saved')).toHaveTextContent('6');
  });

  /**
   * One wrong answer is one sentence, not "1 wrong answers" (ticket 56b). Two
   * keys, because Hindi inflects the verb as well and a template with a plural
   * "s" in it cannot carry that.
   */
  it('says "1 wrong answer was saved" for a single wrong answer', () => {
    render(<AttemptResultPanel result={result({ wrong: 1 })} mode="en" />);
    expect(screen.getByTestId('attempt-result-saved')).toHaveTextContent(
      '1 wrong answer was saved to Saved.',
    );
  });

  it('says "2 wrong answers were saved" for more than one', () => {
    render(<AttemptResultPanel result={result({ wrong: 2 })} mode="en" />);
    expect(screen.getByTestId('attempt-result-saved')).toHaveTextContent(
      '2 wrong answers were saved to Saved.',
    );
  });

  it('says the singular in Hindi too', () => {
    render(<AttemptResultPanel result={result({ wrong: 1 })} mode="hi" />);
    expect(screen.getByTestId('attempt-result-saved')).toHaveTextContent(
      dictionary.hi['result.savedOne'],
    );
  });

  it('has no wrong list and no Saved note for an all-right sitting', () => {
    render(
      <AttemptResultPanel
        result={result({
          score: 20,
          right: 20,
          wrong: 0,
          skipped: 0,
          percent: 100,
          wrongQuestions: [],
        })}
        mode="en"
        outOf={20}
      />,
    );

    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('20 / 20');
    expect(screen.getByTestId('attempt-result-percent')).toHaveTextContent('100%');
    expect(screen.queryByTestId('attempt-result-wrong-row')).toBeNull();
    expect(screen.queryByTestId('attempt-result-saved')).toBeNull();
    expect(screen.getByTestId('attempt-result-none-wrong')).toBeInTheDocument();
  });

  it('shows every wrong question of an all-wrong sitting', () => {
    const wrongQuestions = [1, 2, 3].map((number) => wrongOne(number));
    render(
      <AttemptResultPanel
        result={result({
          score: 0,
          total: 3,
          right: 0,
          wrong: 3,
          skipped: 0,
          percent: 0,
          wrongQuestions,
        })}
        mode="en"
        outOf={3}
      />,
    );

    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('0 / 3');
    expect(screen.getByTestId('attempt-result-percent')).toHaveTextContent('0%');
    expect(screen.getAllByTestId('attempt-result-wrong-row')).toHaveLength(3);
    expect(screen.getByTestId('attempt-result-saved')).toHaveTextContent('3');
  });

  it('shows the same page for a deadline auto-submit, plus the clock line', () => {
    render(
      <AttemptResultPanel
        result={result({
          mode: 'exam',
          score: 24,
          total: 20,
          right: 8,
          wrong: 2,
          skipped: 10,
          percent: 40,
          autoSubmitted: true,
        })}
        mode="en"
        outOf={80}
      />,
    );

    // Everything a finished sitting shows is still here.
    expect(screen.getByTestId('attempt-result-score')).toHaveTextContent('24 / 80');
    expect(screen.getByTestId('attempt-result-right')).toHaveTextContent('8');
    expect(screen.getByTestId('attempt-result-skipped')).toHaveTextContent('10');
    expect(screen.getByTestId('attempt-result-auto')).toBeInTheDocument();
  });

  it('has no clock line when the student pressed Submit', () => {
    render(<AttemptResultPanel result={result({ autoSubmitted: false })} mode="en" />);
    expect(screen.queryByTestId('attempt-result-auto')).toBeNull();
  });

  it('links to the next test without prefetching it (B3)', () => {
    render(<AttemptResultPanel result={result()} mode="en" nextHref="/t/abc/mocks" />);

    const next = screen.getByTestId('attempt-result-next');
    expect(next).toHaveAttribute('href', '/t/abc/mocks');
    // B3: a result page link must not warm a route the student may never open.
    expect(next.getAttribute('prefetch')).toBeNull();
  });

  it('draws no Next test link when there is nowhere to send the student', () => {
    render(<AttemptResultPanel result={result()} mode="en" />);
    expect(screen.queryByTestId('attempt-result-next')).toBeNull();
  });

  it('announces itself to a screen reader and carries Hindi too', () => {
    render(<AttemptResultPanel result={result()} mode="both" outOf={20} />);

    const panel = screen.getByTestId('attempt-result');
    expect(panel).toHaveAttribute('role', 'status');
    // `both` joins English and Hindi, so the Hindi words are on screen.
    expect(panel.textContent).toContain('सही');
    expect(panel.textContent).toContain('छोड़े गए');
  });
});
