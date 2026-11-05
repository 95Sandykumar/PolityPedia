'use client';

/**
 * The audio bar on the Revision (AI) screen (issue 25-revision-audio).
 *
 * DESIGN.md section 8: "audio bar (play/pause, 1x / 1.25x / 1.5x speed)".
 * Definition of done: "Students press play and choose 1x, 1.25x or 1.5x."
 *
 * A REAL `<audio>` element, not a fetch and a decoder. The browser already
 * streams, buffers, handles the lock screen and survives a tab change, and
 * `playbackRate` is what it uses for speed, so the chips set that property
 * directly rather than keeping a number our own code has to apply.
 *
 * `preload="none"`, which is the point of the whole bar on a cheap Android
 * phone and a metered connection (DESIGN.md D1): a student who only reads the
 * explanation downloads nothing at all. The first byte moves when they press
 * play.
 *
 * `src` is OUR route, never a bucket URL. The bucket is private, so the file
 * needs a signed URL that dies after an hour; a fresh one per play comes from
 * GET /api/revision/audio. See `audio-route.ts`.
 *
 * A11y: one toggle button whose `aria-label` says Play or Pause in the
 * student's language, and three chips with `aria-pressed`, so a screen reader
 * says which speed is on. Every control is at least 48px (DESIGN.md D4).
 */
import { Pause, Play, Volume2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { AUDIO_SPEEDS, DEFAULT_AUDIO_SPEED, explanationAudioUrl } from '@/lib/ai/audio';
import { DEFAULT_MODE, plain, type Lang, type LangMode } from '@/lib/i18n';

const CHIP =
  'inline-flex min-h-12 items-center justify-center rounded-full border px-3 ' +
  'text-sm font-medium transition-colors duration-100';

const TOGGLE =
  'inline-flex min-h-12 min-w-12 items-center justify-center rounded-[10px] ' +
  'bg-primary text-primary-foreground transition-colors duration-100';

export function RevisionAudioBar({
  questionId,
  lang,
  mode = DEFAULT_MODE,
}: {
  questionId: string;
  /** The language the explanation is WRITTEN in. Never the mode `both`. */
  lang: Lang;
  /** The student's display mode, for every label on the bar. */
  mode?: LangMode;
}) {
  const element = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(DEFAULT_AUDIO_SPEED);

  function toggle(): void {
    const audio = element.current;
    if (!audio) return;

    if (playing) {
      // `pause` is synchronous everywhere, but a dead element still must not
      // leave the button stuck on "Pause".
      try {
        audio.pause();
      } catch {
        // Nothing to do: the `onPause` handler never fires, so the state is
        // put straight below.
      }
      setPlaying(false);
      return;
    }

    // `play()` rejects on its own for autoplay rules and a missing file, and
    // THROWS in a browser with no media engine. Both end the same way: the
    // button stays on Play, and the student sees no error, because a silent
    // explanation is still a readable one.
    try {
      const started = audio.play();
      setPlaying(true);
      void Promise.resolve(started).catch(() => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  }

  function choose(next: number): void {
    setSpeed(next);
    const audio = element.current;
    // Straight onto the element: this is the property the browser plays at,
    // so there is no second source of truth to drift.
    if (audio) audio.playbackRate = next;
  }

  return (
    <div
      data-testid="revision-audio-bar"
      className="flex flex-wrap items-center gap-2 border-t border-border pt-2"
    >
      {/* No `controls`: the two things DESIGN.md asks for are below, and the
          native bar would add a download button for a private file. */}
      <audio
        ref={element}
        data-testid="revision-audio"
        src={explanationAudioUrl(questionId, lang)}
        preload="none"
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlaying={() => setPlaying(true)}
        onError={() => setPlaying(false)}
      />

      <button
        type="button"
        data-testid="revision-audio-toggle"
        aria-label={plain(playing ? 'revision.pause' : 'revision.play', mode)}
        onClick={toggle}
        className={TOGGLE}
      >
        {playing ? (
          <Pause aria-hidden="true" className="size-5" />
        ) : (
          <Play aria-hidden="true" className="size-5" />
        )}
      </button>

      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <Volume2 aria-hidden="true" className="size-4 shrink-0" />
        {plain('revision.listen', mode)}
      </span>

      {/* The speed chips. A group label, so a screen reader hears what the
          three numbers are for. */}
      <div
        role="group"
        aria-label={plain('revision.speed', mode)}
        className="ml-auto flex items-center gap-1"
      >
        {AUDIO_SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`revision-speed-${value}`}
            aria-pressed={speed === value}
            onClick={() => choose(value)}
            className={`${CHIP} ${
              speed === value
                ? 'border-primary text-primary'
                : 'border-border text-muted-foreground'
            }`}
          >
            {value}x
          </button>
        ))}
      </div>
    </div>
  );
}
