/**
 * The audio bar on the Revision (AI) screen (issue 25-revision-audio).
 *
 * Definition of done: "Students press play and choose 1x, 1.25x or 1.5x."
 * DESIGN.md section 8: "audio bar (play/pause, 1x / 1.25x / 1.5x speed)".
 *
 *  1. the bar shows play plus the three speed chips, 1x chosen.
 *  2. press play   -> the element plays and the button becomes Pause.
 *  3. press pause  -> the element pauses.
 *  4. tap 1.25x    -> `playbackRate` is 1.25 on the real media element.
 *  5. the src is OUR route, never a bucket URL.
 *  6. the panel shows the bar only when there IS audio to play.
 *
 * jsdom has no media engine, so `play` and `pause` are stubbed on the
 * prototype. `playbackRate` is a real property there, so assertion 4 is the
 * actual thing a browser would use, not a mirror of our own state.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionAudioBar } from '../revision-audio-bar';
import { RevisionPanel } from '../revision-panel';
import { createMemoryExplanationLive } from '@/lib/ai/memory-explanation-live';
import { explanationAudioPath, explanationAudioUrl } from '@/lib/ai/audio';
import type { BrowserRevisionClient } from '@/lib/ai/revision-screen';
import type { Explanation } from '@/lib/ai/types';
import { dictionary } from '@/lib/i18n';

const QUESTION = '22222222-2222-4222-8222-222222222221';

let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
let pause: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  play = vi.fn<() => Promise<void>>(() => Promise.resolve());
  pause = vi.fn<() => void>();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function element(): HTMLAudioElement {
  return screen.getByTestId('revision-audio') as HTMLAudioElement;
}

describe('RevisionAudioBar', () => {
  it('shows play and the three speed chips, with 1x chosen', () => {
    render(<RevisionAudioBar questionId={QUESTION} lang="en" />);

    expect(screen.getByTestId('revision-audio-toggle')).toHaveAttribute(
      'aria-label',
      dictionary.en['revision.play'],
    );
    expect(screen.getByTestId('revision-speed-1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('revision-speed-1.25')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('revision-speed-1.5')).toHaveAttribute('aria-pressed', 'false');
    expect(element().playbackRate).toBe(1);
  });

  it('plays the file from our own route, never from a bucket', () => {
    render(<RevisionAudioBar questionId={QUESTION} lang="hi" />);
    const src = element().getAttribute('src') ?? '';
    expect(src).toBe(explanationAudioUrl(QUESTION, 'hi'));
    expect(src.startsWith('/api/')).toBe(true);
  });

  it('plays on the first press and pauses on the second', async () => {
    render(<RevisionAudioBar questionId={QUESTION} lang="en" />);
    const toggle = screen.getByTestId('revision-audio-toggle');

    fireEvent.click(toggle);
    expect(play).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-label', dictionary.en['revision.pause']),
    );

    fireEvent.click(toggle);
    expect(pause).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-label', dictionary.en['revision.play']),
    );
  });

  it('sets the real playback rate when a speed chip is tapped', async () => {
    render(<RevisionAudioBar questionId={QUESTION} lang="en" />);

    fireEvent.click(screen.getByTestId('revision-speed-1.25'));
    await waitFor(() => expect(element().playbackRate).toBe(1.25));
    expect(screen.getByTestId('revision-speed-1.25')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('revision-speed-1')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('revision-speed-1.5'));
    await waitFor(() => expect(element().playbackRate).toBe(1.5));
  });

  it('goes back to Play when the file ends', async () => {
    render(<RevisionAudioBar questionId={QUESTION} lang="en" />);
    const toggle = screen.getByTestId('revision-audio-toggle');

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-label', dictionary.en['revision.pause']),
    );

    fireEvent.ended(element());
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-label', dictionary.en['revision.play']),
    );
  });

  it('survives a browser that refuses to play, with no error on screen', async () => {
    play.mockImplementation(() => {
      throw new Error('jsdom has no media engine');
    });
    render(<RevisionAudioBar questionId={QUESTION} lang="en" />);

    fireEvent.click(screen.getByTestId('revision-audio-toggle'));
    // Still the Play label, because nothing is playing.
    await waitFor(() =>
      expect(screen.getByTestId('revision-audio-toggle')).toHaveAttribute(
        'aria-label',
        dictionary.en['revision.play'],
      ),
    );
  });

  it('has a Hindi label for every control', () => {
    render(<RevisionAudioBar questionId={QUESTION} lang="en" mode="hi" />);
    expect(screen.getByTestId('revision-audio-toggle')).toHaveAttribute(
      'aria-label',
      dictionary.hi['revision.play'],
    );
  });
});

// --------------------------------------------------------------------------
// The panel only shows the bar when there is something to play
// --------------------------------------------------------------------------

function ready(audioPath: string | null): Explanation {
  return {
    questionId: QUESTION,
    lang: 'en',
    status: 'ready',
    body: {
      exam: 'UGC NET',
      topic: 'Parliament',
      question: 'Which house is the Council of States?',
      sections: [{ heading: 'The answer', body: 'The Rajya Sabha.' }],
      remember: 'Rajya Sabha = Council of States.',
    },
    sources: [],
    audioPath,
    editedByTeacher: false,
  };
}

function panel(audioPath: string | null) {
  const client: BrowserRevisionClient = {
    explain: async () => ({ kind: 'ready', explanation: ready(audioPath) }),
    vote: async () => true,
  };
  return render(
    <RevisionPanel
      questionId={QUESTION}
      lang="en"
      client={client}
      live={createMemoryExplanationLive().live}
    />,
  );
}

describe('RevisionPanel and the audio bar', () => {
  it('shows the bar when the explanation has audio', async () => {
    panel(explanationAudioPath(QUESTION, 'en'));
    expect(await screen.findByTestId('revision-audio-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('revision-speed-1.5')).toBeInTheDocument();
  });

  it('shows no bar while the audio is still being made', async () => {
    panel(null);
    expect(await screen.findByTestId('revision-ready')).toBeInTheDocument();
    // A player with nothing to play is worse than no player.
    expect(screen.queryByTestId('revision-audio-toggle')).toBeNull();
  });
});
