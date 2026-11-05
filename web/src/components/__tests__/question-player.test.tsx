/**
 * The question player (issue 13-question-player).
 *
 * Definition of done: "A student opens a live past paper and answers questions
 * one by one: progress bar with '12 / 100', 4 outline options, Reveal answer,
 * Mark for later, Next. After a tap, the result shows on the same screen under
 * the options."
 *
 * D3 in DESIGN.md is the locked decision behind it: the result is on the SAME
 * screen, with no page load. So every assertion here happens after a click and
 * without a re-render from the outside.
 *
 * The write path is a FAKE `save`, so no test makes a network call
 * (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionPlayer } from '../question-player';
import { createMemoryExplanationLive } from '@/lib/ai/memory-explanation-live';
import { createAnswerQueue } from '@/lib/attempts/answer-queue';
import type { AnswerUpsert } from '@/lib/attempts/types';
import type { SavedTag } from '@/lib/saved/types';
import { dictionary } from '@/lib/i18n';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';

const HOUSES: QuestionOptions = ['Lok Sabha', 'Rajya Sabha', 'Both houses', 'Neither house'];
const ORGANS: QuestionOptions = ['Union', 'State', 'Concurrent', 'Residuary'];

function question(values: Partial<Question> & { id: string }): Question {
  return {
    teacherId: TEACHER,
    paperId: PAPER,
    testId: null,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: HOUSES,
    correctIdx: 1,
    teacherExplanation: 'Article 80 names the Rajya Sabha the Council of States.',
    topicId: null,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'live',
    ...values,
  };
}

const Q1 = question({ id: '22222222-2222-4222-8222-222222222221' });
const Q2 = question({
  id: '22222222-2222-4222-8222-222222222222',
  number: 2,
  stem: 'Which list carries police?',
  options: ORGANS,
  correctIdx: 1,
  teacherExplanation: null,
});

/** A fake transport plus the queue the real player uses. */
function setup(questions: readonly Question[] = [Q1, Q2]) {
  const sent: AnswerUpsert[] = [];
  const save = vi.fn(async (one: AnswerUpsert) => {
    sent.push(one);
  });
  const queue = createAnswerQueue({ save });
  const view = render(
    <QuestionPlayer questions={questions} attemptId={ATTEMPT} queue={queue} />,
  );
  return { sent, save, queue, view };
}

/** The four option buttons, in A B C D order. */
function options(): HTMLElement[] {
  return screen.getAllByTestId('player-option');
}

function clickOption(index: number): void {
  fireEvent.click(options()[index]);
}

/**
 * A label as a regex. Escaped, because "Revision (AI)" has brackets in it and
 * an unescaped one would match "RevisionAI" instead.
 */
function rx(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function button(key: keyof (typeof dictionary)['en']): HTMLElement {
  return screen.getByRole('button', { name: rx(dictionary.en[key]) });
}

function maybeButton(key: keyof (typeof dictionary)['en']): HTMLElement | null {
  return screen.queryByRole('button', { name: rx(dictionary.en[key]) });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('QuestionPlayer: the question', () => {
  it('shows the progress as "1 / 2" and moves to "2 / 2" on Next', () => {
    setup();

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '2');
    expect(screen.getByTestId('player-progress')).toHaveTextContent('1 / 2');

    fireEvent.click(button('player.next'));

    expect(screen.getByTestId('player-progress')).toHaveTextContent('2 / 2');
    expect(screen.getByText(Q2.stem)).toBeInTheDocument();
  });

  it('draws four options as real buttons, lettered A to D', () => {
    setup();

    const all = options();
    expect(all).toHaveLength(4);
    for (const one of all) expect(one.tagName).toBe('BUTTON');

    for (const [index, letter] of ['A', 'B', 'C', 'D'].entries()) {
      expect(all[index]).toHaveTextContent(letter);
      expect(all[index]).toHaveTextContent(HOUSES[index]);
    }
  });

  it('gives every option the 56 px minimum height', () => {
    // DESIGN.md section 5 and the a11y checklist: options are 56 px.
    setup();
    for (const one of options()) expect(one.className).toContain('min-h-14');
  });

  it('shows an empty state instead of an empty player', () => {
    setup([]);
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['player.none']);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('QuestionPlayer: the wrong answer', () => {
  it('shows Wrong, the right option, the chosen option and a CLOSED accordion', () => {
    setup();

    // The correct index is 1, so option A is wrong.
    clickOption(0);

    // The result is on the same screen, under the options, and announced.
    const result = screen.getByTestId('player-result');
    expect(result).toHaveAttribute('aria-live', 'polite');
    expect(result).toHaveTextContent(dictionary.en['player.wrong']);
    // Colour never works alone (DESIGN.md section 3): there is an icon too.
    expect(result.querySelector('[data-icon="wrong"]')).not.toBeNull();

    // The right option is marked right, the chosen one is marked wrong.
    expect(options()[1]).toHaveAttribute('data-state', 'right');
    expect(options()[0]).toHaveAttribute('data-state', 'wrong');
    expect(options()[2]).toHaveAttribute('data-state', 'idle');
    expect(options()[1]).toHaveTextContent(dictionary.en['player.rightOption']);
    expect(options()[0]).toHaveTextContent(dictionary.en['player.yourOption']);

    // "Teacher explanation" accordion, CLOSED.
    const accordion = screen.getByTestId('player-explanation');
    expect(accordion.tagName).toBe('DETAILS');
    expect(accordion).not.toHaveAttribute('open');
    expect(accordion).toHaveTextContent(dictionary.en['player.explanation']);

    // Revision (AI) is the primary button, Next the secondary one.
    expect(button('player.revision')).toBeInTheDocument();
    expect(button('player.next')).toBeInTheDocument();
    // Mark for later belongs to the right answer, not this one.
    expect(maybeButton('player.mark')).toBeNull();
  });

  it('opens the teacher explanation only when the student asks', () => {
    setup();
    clickOption(0);

    // A plain <details>: "closed" is the missing `open` attribute, and the
    // text is in the DOM either way, which is why the attribute is asserted
    // and not the text.
    const accordion = screen.getByTestId('player-explanation');
    expect(accordion).not.toHaveAttribute('open');

    fireEvent.click(screen.getByText(dictionary.en['player.explanation']));
    expect(accordion).toHaveAttribute('open');
    expect(accordion).toHaveTextContent(Q1.teacherExplanation as string);
  });

  it('says so when the teacher wrote no explanation', () => {
    setup([Q2]);
    clickOption(0);
    expect(screen.getByTestId('player-explanation')).toHaveTextContent(
      dictionary.en['player.noExplanation'],
    );
  });

  it('Revision (AI) opens the explanation on the same screen', async () => {
    // The panel's two outside things are fakes, so this test makes no network
    // call and opens no socket (issue 23-revision-screen).
    const explain = vi.fn(async () => ({
      kind: 'ready' as const,
      explanation: {
        questionId: Q1.id,
        lang: 'en' as const,
        status: 'ready' as const,
        body: {
          exam: 'UGC NET',
          topic: 'Parliament',
          question: 'Which house is the Council of States?',
          sections: [{ heading: 'The answer', body: 'The Rajya Sabha.' }],
          remember: 'Rajya Sabha = Council of States.',
        },
        sources: [],
        audioPath: null,
        editedByTeacher: false,
      },
    }));
    const stream = createMemoryExplanationLive();
    const queue = createAnswerQueue({ save: async () => {} });
    render(
      <QuestionPlayer
        questions={[Q1, Q2]}
        attemptId={ATTEMPT}
        queue={queue}
        revisionClient={{ explain, vote: vi.fn(async () => true) }}
        revisionLive={stream.live}
      />,
    );

    clickOption(0);
    // Nothing is asked for until the student taps: no call for a student who
    // reads the teacher's words and moves on.
    expect(explain).not.toHaveBeenCalled();

    fireEvent.click(button('player.revision'));

    expect(await screen.findByTestId('revision-ready')).toBeInTheDocument();
    expect(screen.getByTestId('revision-section')).toHaveTextContent('The answer');
    expect(explain).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledWith({ questionId: Q1.id, lang: 'en' });
    // The placeholder from issue 13 is gone.
    expect(screen.queryByTestId('player-revision-soon')).toBeNull();
  });
});

describe('QuestionPlayer: the right answer', () => {
  it('shows Correct, Mark for later and Next', () => {
    setup();

    clickOption(1);

    const result = screen.getByTestId('player-result');
    expect(result).toHaveAttribute('aria-live', 'polite');
    expect(result).toHaveTextContent(dictionary.en['player.correct']);
    expect(result.querySelector('[data-icon="correct"]')).not.toBeNull();

    expect(options()[1]).toHaveAttribute('data-state', 'right');

    expect(button('player.mark')).toBeInTheDocument();
    expect(button('player.next')).toBeInTheDocument();
    // Nothing to revise: Revision (AI) is for a wrong answer.
    expect(maybeButton('player.revision')).toBeNull();
  });
});

describe('QuestionPlayer: writing the answer', () => {
  it('sends one upsert per tap, keyed by attempt and question', async () => {
    const { sent } = setup();

    clickOption(0);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      attemptId: ATTEMPT,
      questionId: Q1.id,
      chosenIdx: 0,
      isCorrect: false,
      marked: false,
    });
  });

  it('a second tap on the same question keeps the same key (A1)', async () => {
    // One row in the database, because the key is (attempt_id, question_id).
    // `test/attempts.test.ts` proves the row count; this proves the player
    // never invents a second key for the same question.
    const { sent } = setup();

    clickOption(0);
    await waitFor(() => expect(sent).toHaveLength(1));
    clickOption(2);
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1].questionId).toBe(sent[0].questionId);
    expect(sent[1].attemptId).toBe(sent[0].attemptId);
    expect(sent[1].chosenIdx).toBe(2);
  });

  it('Mark for later stores the mark with no answer', async () => {
    const { sent } = setup();

    fireEvent.click(button('player.mark'));
    await waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toEqual({
      attemptId: ATTEMPT,
      questionId: Q1.id,
      chosenIdx: null,
      isCorrect: null,
      marked: true,
    });
    // The button flips, so the student can see the mark took.
    expect(screen.getByTestId('player-mark')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the answer on screen when the student walks back and forth', () => {
    setup();

    clickOption(0);
    fireEvent.click(button('player.next'));
    expect(screen.queryByTestId('player-result')).toBeNull();

    fireEvent.click(button('player.prev'));
    // Same screen, same result: the answers live in the player, not in a URL.
    expect(screen.getByTestId('player-result')).toHaveTextContent(
      dictionary.en['player.wrong'],
    );
    expect(options()[0]).toHaveAttribute('data-state', 'wrong');
  });
});

describe('QuestionPlayer: Reveal answer', () => {
  it('shows the right option without calling it right or wrong', () => {
    const { sent } = setup();

    fireEvent.click(button('player.reveal'));

    expect(options()[1]).toHaveAttribute('data-state', 'right');
    const result = screen.getByTestId('player-result');
    expect(result).toHaveTextContent(dictionary.en['player.answer']);
    expect(result).not.toHaveTextContent(dictionary.en['player.wrong']);
    // A reveal is not an answer, so there is nothing to score and nothing to
    // store.
    expect(sent).toHaveLength(0);
  });

  it('is gone once the question has been answered', () => {
    setup();
    clickOption(1);
    expect(maybeButton('player.reveal')).toBeNull();
  });
});

describe('QuestionPlayer: offline', () => {
  it('shows the offline banner and keeps the answer', async () => {
    const sent: AnswerUpsert[] = [];
    let online = false;
    const queue = createAnswerQueue({
      save: async (one) => {
        if (!online) throw new Error('offline');
        sent.push(one);
      },
      isOnline: () => online,
    });

    render(<QuestionPlayer questions={[Q1]} attemptId={ATTEMPT} queue={queue} />);

    // The browser tells the page, the same event the real player listens to.
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('player-offline')).toHaveTextContent(
      dictionary.en['player.offline'],
    );

    clickOption(0);
    await waitFor(() => expect(queue.pending()).toBe(1));
    expect(sent).toHaveLength(0);
    // The result is still shown: the student answered, the network did not.
    expect(screen.getByTestId('player-result')).toHaveTextContent(
      dictionary.en['player.wrong'],
    );

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(queue.pending()).toBe(0);
    expect(screen.queryByTestId('player-offline')).toBeNull();
  });
});

describe('QuestionPlayer: the end', () => {
  it('finishes on the last question and shows the score', async () => {
    const onFinish = vi.fn();
    const save = vi.fn(async () => {});
    const queue = createAnswerQueue({ save });
    render(
      <QuestionPlayer
        questions={[Q1, Q2]}
        attemptId={ATTEMPT}
        queue={queue}
        onFinish={onFinish}
      />,
    );

    clickOption(1); // right
    fireEvent.click(button('player.next'));
    clickOption(0); // wrong

    // There is no next question, so Next is a Finish.
    expect(maybeButton('player.next')).toBeNull();
    fireEvent.click(button('player.finish'));

    expect(screen.getByTestId('player-score')).toHaveTextContent('1 / 2');
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(1));
  });
});

describe('QuestionPlayer: Hindi', () => {
  it('shows every label in Hindi', () => {
    const queue = createAnswerQueue({ save: async () => {} });
    render(
      <QuestionPlayer questions={[Q1]} attemptId={ATTEMPT} queue={queue} mode="hi" />,
    );

    expect(
      screen.getByRole('button', { name: rx(dictionary.hi['player.mark']) }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: rx(dictionary.hi['player.reveal']) }),
    ).toBeInTheDocument();
  });
});

describe('QuestionPlayer: the Saved list (issue 14-saved-list)', () => {
  /** The player with a spy on the saved-tag sink. */
  function withTags(questions: readonly Question[] = [Q1, Q2]) {
    const tagged: { questionId: string; tag: SavedTag; saved: boolean }[] = [];
    const onTag = vi.fn((questionId: string, tag: SavedTag, saved: boolean) => {
      tagged.push({ questionId, tag, saved });
    });
    const queue = createAnswerQueue({ save: async () => {} });
    render(
      <QuestionPlayer
        questions={questions}
        attemptId={ATTEMPT}
        queue={queue}
        onTag={onTag}
      />,
    );
    return { tagged, onTag };
  }

  it('a wrong answer saves itself with the tag Wrong', () => {
    const { tagged } = withTags();

    // Q1 correctIdx is 1, so option A is wrong.
    clickOption(0);

    expect(tagged).toEqual([{ questionId: Q1.id, tag: 'wrong', saved: true }]);
  });

  it('a right answer saves nothing', () => {
    const { tagged } = withTags();

    clickOption(1);

    expect(tagged).toEqual([]);
  });

  it('sends the same wrong tag once per tap, and the key keeps it one row', () => {
    const { tagged } = withTags();

    clickOption(0);
    clickOption(2);

    // Two taps, two sends, ONE row: the key is (user_id, question_id, tag),
    // and `test/saved.test.ts` proves the row count in Postgres.
    expect(tagged).toHaveLength(2);
    expect(tagged.every((one) => one.tag === 'wrong' && one.questionId === Q1.id)).toBe(
      true,
    );
  });

  it('Mark for later saves the tag Marked, and un-marking removes it', () => {
    const { tagged } = withTags();

    fireEvent.click(button('player.mark'));
    expect(tagged).toEqual([{ questionId: Q1.id, tag: 'marked', saved: true }]);

    fireEvent.click(button('player.mark'));
    expect(tagged[1]).toEqual({ questionId: Q1.id, tag: 'marked', saved: false });
  });

  it('works with no sink at all, so the player never needs one', () => {
    setup();

    clickOption(0);

    expect(screen.getByTestId('player-result')).toHaveTextContent(
      dictionary.en['player.wrong'],
    );
  });
});
