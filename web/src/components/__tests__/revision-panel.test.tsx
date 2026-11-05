/**
 * The Revision (AI) screen (issue 23-revision-screen).
 *
 * Definition of done: "From a wrong answer, a student taps Revision (AI) and
 * sees the explanation: Exam and Topic chips, the question in short, sections
 * with headings, a Remember box, and Sources. A student without a plan sees a
 * card 'AI explanation Rs 100/month' and the teacher explanation stays
 * visible. At the limit they see '30 new explanations used today. Saved ones
 * still work.'"
 *
 * Four states, one test each, plus the two that are easy to get wrong:
 *
 *  1. ready      -> sections AND sources are on screen.
 *  2. loading    -> skeleton + "Writing explanation..." with `aria-busy`.
 *  3. no plan    -> the Rs 100 card AND the teacher explanation.
 *  4. limit      -> the one sentence, and no skeleton.
 *  5. generating -> B6: the row is PUSHED. The fake `Live` pushes `ready` and
 *                   the screen updates with NO second request. A polling
 *                   implementation fails this test, because `explain` is
 *                   asserted to have been called exactly once.
 *  6. thumbs     -> one vote per tap, through the injected client.
 *
 * Every outside call is a FAKE: no `fetch`, no socket, no key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RevisionPanel } from '../revision-panel';
import { createMemoryExplanationLive } from '@/lib/ai/memory-explanation-live';
import {
  PLANS_PATH,
  type BrowserRevisionClient,
  type RevisionOutcome,
} from '@/lib/ai/revision-screen';
import type { Explanation } from '@/lib/ai/types';
import { dictionary } from '@/lib/i18n';

const QUESTION = '22222222-2222-4222-8222-222222222221';

const TEACHER_TEXT = 'Article 80 names the Rajya Sabha the Council of States.';

const READY: Explanation = {
  questionId: QUESTION,
  lang: 'en',
  status: 'ready',
  body: {
    exam: 'UGC NET',
    topic: 'Parliament',
    question: 'Which house is the Council of States?',
    sections: [
      { heading: 'The answer', body: 'The Rajya Sabha is the Council of States.' },
      {
        heading: 'Why the other options are wrong',
        body: 'The Lok Sabha is the House of the People.',
      },
    ],
    remember: 'Rajya Sabha = Council of States.',
  },
  sources: [{ title: 'India Code', url: 'https://www.indiacode.nic.in/' }],
  audioPath: null,
  editedByTeacher: false,
};

interface Fake {
  client: BrowserRevisionClient;
  explain: ReturnType<typeof vi.fn>;
  vote: ReturnType<typeof vi.fn>;
}

/** A client that answers with one fixed outcome. */
function fakeClient(outcome: RevisionOutcome | Promise<RevisionOutcome>): Fake {
  const explain = vi.fn(async () => outcome);
  const vote = vi.fn(async () => true);
  return { client: { explain, vote } as BrowserRevisionClient, explain, vote };
}

function setup(
  outcome: RevisionOutcome | Promise<RevisionOutcome>,
  extra: { teacherExplanation?: string | null } = {},
) {
  const fake = fakeClient(outcome);
  const stream = createMemoryExplanationLive();
  const view = render(
    <RevisionPanel
      questionId={QUESTION}
      lang="en"
      client={fake.client}
      live={stream.live}
      teacherExplanation={
        extra.teacherExplanation === undefined ? TEACHER_TEXT : extra.teacherExplanation
      }
    />,
  );
  return { ...fake, stream, view };
}

describe('RevisionPanel', () => {
  it('ready: Exam and Topic chips, the question, sections, Remember and Sources', async () => {
    setup({ kind: 'ready', explanation: READY });

    const ready = await screen.findByTestId('revision-ready');
    expect(ready).toBeInTheDocument();

    // Exam . Topic chips.
    expect(screen.getByTestId('revision-chip-exam')).toHaveTextContent('UGC NET');
    expect(screen.getByTestId('revision-chip-topic')).toHaveTextContent('Parliament');

    // The question in short.
    expect(screen.getByTestId('revision-question')).toHaveTextContent(
      'Which house is the Council of States?',
    );

    // Sections with HEADINGS, not one blob of prose.
    const sections = screen.getAllByTestId('revision-section');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveTextContent('The answer');
    expect(sections[0]).toHaveTextContent('The Rajya Sabha is the Council of States.');
    expect(sections[1]).toHaveTextContent('Why the other options are wrong');

    // The Remember box.
    const remember = screen.getByTestId('revision-remember');
    expect(remember).toHaveTextContent(dictionary.en['revision.remember']);
    expect(remember).toHaveTextContent('Rajya Sabha = Council of States.');

    // Sources, as real links.
    const sources = screen.getByTestId('revision-sources');
    expect(sources).toHaveTextContent(dictionary.en['revision.sources']);
    const link = screen.getByRole('link', { name: 'India Code' });
    expect(link).toHaveAttribute('href', 'https://www.indiacode.nic.in/');

    // Nothing is loading any more.
    expect(screen.queryByTestId('revision-loading')).toBeNull();
  });

  it('loading: a skeleton and "Writing explanation..." with aria-busy', async () => {
    // A promise nobody resolves, so the screen stays in its loading state.
    const held = new Promise<RevisionOutcome>(() => {});
    setup(held);

    const loading = await screen.findByTestId('revision-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).toHaveTextContent(dictionary.en['revision.writing']);
    expect(screen.getAllByTestId('revision-skeleton').length).toBeGreaterThan(0);
  });

  it('no plan: the Rs 100 card, Subscribe, and the teacher explanation stays visible', async () => {
    setup({ kind: 'error', error: 'no_plan' });

    const card = await screen.findByTestId('revision-upsell');
    expect(card).toHaveTextContent(dictionary.en['revision.noPlan']);

    const subscribe = screen.getByRole('link', {
      name: new RegExp(dictionary.en['revision.subscribe'], 'i'),
    });
    expect(subscribe).toHaveAttribute('href', PLANS_PATH);

    // The student is not left with nothing: the teacher's own words stay.
    expect(screen.getByTestId('revision-teacher')).toHaveTextContent(TEACHER_TEXT);
  });

  it('limit: 30 new explanations used today, and no skeleton', async () => {
    setup({ kind: 'error', error: 'limit' });

    const limit = await screen.findByTestId('revision-limit');
    expect(limit).toHaveTextContent(dictionary.en['revision.limit']);
    expect(screen.queryByTestId('revision-loading')).toBeNull();
    expect(screen.queryByTestId('revision-ready')).toBeNull();
  });

  it('generating: the fake Live pushes ready and the screen updates, with NO second request', async () => {
    const { stream, explain } = setup({ kind: 'generating' });

    // Somebody else's call is in flight: skeleton, and we are watching.
    const loading = await screen.findByTestId('revision-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(stream.watching()).toHaveLength(1));

    // B6: the row arrives pushed.
    stream.push(READY);

    expect(await screen.findByTestId('revision-ready')).toBeInTheDocument();
    expect(screen.getAllByTestId('revision-section')).toHaveLength(2);
    // Pushed, not polled.
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('thumbs up sends one vote and thanks the student', async () => {
    const { vote } = setup({ kind: 'ready', explanation: READY });

    await screen.findByTestId('revision-ready');
    const up = screen.getByTestId('revision-thumb-up');
    expect(up).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(up);

    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'true'));
    expect(vote).toHaveBeenCalledTimes(1);
    expect(vote).toHaveBeenCalledWith({ questionId: QUESTION, lang: 'en', vote: 'up' });
    expect(screen.getByTestId('revision-feedback')).toHaveTextContent(
      dictionary.en['revision.feedbackThanks'],
    );
  });

  it('stops watching the row when the panel closes', async () => {
    const { stream, view } = setup({ kind: 'generating' });

    await waitFor(() => expect(stream.watching()).toHaveLength(1));
    view.unmount();
    expect(stream.watching()).toHaveLength(0);
  });
});
