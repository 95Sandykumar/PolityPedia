'use client';

/**
 * The Revision (AI) screen (issue 23-revision-screen).
 *
 * DESIGN.md section 8: "While loading: a skeleton plus 'Writing
 * explanation...' (`aria-busy`). Saved explanations open instantly. Layout:
 * Exam . Topic chips, the question in short, explanation sections with
 * headings, Sources (links), audio bar. Thumbs up/down under it (feedback
 * goes to the teacher). Not on a plan: one card 'AI explanation Rs
 * 100/month' with Subscribe, and the teacher explanation stays visible. Limit
 * reached: '30 new explanations used today. Saved ones still work.'"
 *
 * B6, THE DESIGN CHECK THIS FILE EXISTS TO HONOUR: there is NO TIMER here. A
 * second student who tapped Revision one moment after the first one gets
 * `202 generating` and then waits on the `ExplanationLive` push. One request
 * per tap, ever. A `setInterval` asking "is it written yet" would also work
 * and would cost a model call's worth of traffic for every student in a batch.
 *
 * Both outside things are PROPS, so the test drives the whole screen with no
 * `fetch`, no socket and no key (web/CLAUDE.md). The defaults are built lazily
 * inside the component, so importing this file does no work.
 *
 * THE AUDIO BAR (issue 25-revision-audio) is drawn only when `audioPath` is
 * set, because a player with nothing to play is worse than no player. The
 * audio is made in the background after the text is saved, so the first
 * student to open a brand-new explanation reads it in silence and everybody
 * after them gets the bar. That is the trade F-F5 asks for: the voice is paid
 * per character, so it is made once, not once per reader.
 *
 * A11y: the skeleton is `role="status"` + `aria-busy`, the thumbs are real
 * buttons with `aria-pressed` and an `aria-label` in the current language, and
 * every section heading is a real heading so a screen reader can jump.
 */
import { ExternalLink, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { RevisionAudioBar } from '@/components/revision-audio-bar';
import { createBrowserRevisionClient } from '@/lib/ai/browser-revision-client';
import type { FeedbackVote } from '@/lib/ai/feedback';
import { REVISION_ERROR_LABEL } from '@/lib/ai/labels';
import { createMemoryExplanationLive } from '@/lib/ai/memory-explanation-live';
import {
  PLANS_PATH,
  type BrowserRevisionClient,
  type ExplanationLive,
} from '@/lib/ai/revision-screen';
import { createSupabaseExplanationLive } from '@/lib/ai/supabase-explanation-live';
import type { Explanation } from '@/lib/ai/types';
import type { RevisionError } from '@/lib/ai/revision-route';
import { DEFAULT_MODE, labels, plain, type Lang, type LangMode } from '@/lib/i18n';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

const CHIP = 'rounded-full border border-border px-2 py-0.5 text-xs font-medium';

const THUMB =
  'inline-flex min-h-12 min-w-12 items-center justify-center rounded-[10px] border px-3 ' +
  'text-base transition-colors duration-100';

/** What the screen is showing right now. */
type View =
  /** Our own request is in flight. */
  | { kind: 'loading' }
  /** Somebody else's call is in flight. We wait on the push (B6). */
  | { kind: 'generating' }
  | { kind: 'ready'; explanation: Explanation }
  | { kind: 'error'; error: RevisionError };

/** The two refusals that are their own screen, not an error line. */
const OWN_SCREEN: readonly RevisionError[] = ['no_plan', 'limit'];

export function RevisionPanel({
  questionId,
  lang,
  mode = DEFAULT_MODE,
  teacherExplanation = null,
  client,
  live,
  configured = true,
}: {
  questionId: string;
  /** The language the explanation is WRITTEN in. Never the mode `both`. */
  lang: Lang;
  /** The student's display mode, for every label on the screen. */
  mode?: LangMode;
  /**
   * The teacher's own words. Shown when there is no plan, so the student is
   * never left with a paywall and nothing else (DoD). The player's accordion
   * above is closed by default, so this is not a visible duplicate.
   */
  teacherExplanation?: string | null;
  client?: BrowserRevisionClient;
  live?: ExplanationLive;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallbackClient = useMemo(() => createBrowserRevisionClient(), []);
  const data = client ?? fallbackClient;

  // With no keys there is nothing to watch, so an empty stream is the right
  // answer rather than a null check at the call site.
  const fallbackLive = useMemo(
    () =>
      configured
        ? createSupabaseExplanationLive({ accessToken: '' })
        : createMemoryExplanationLive().live,
    [configured],
  );
  const stream = live ?? fallbackLive;

  const [view, setView] = useState<View>({ kind: 'loading' });
  const [vote, setVote] = useState<FeedbackVote | null>(null);
  /** Bumped by Try again, so the effect below asks once more. */
  const [attempt, setAttempt] = useState(0);

  // ONE request per attempt. `explain` never throws, so there is no catch: a
  // dead network is an `error` outcome with the same line as a model failure.
  useEffect(() => {
    if (!configured) return;
    let alive = true;

    setView({ kind: 'loading' });
    void data.explain({ questionId, lang }).then((outcome) => {
      // The student moved on to the next question. Dropping the reply keeps a
      // late answer from overwriting the question that is on screen now.
      if (!alive) return;
      if (outcome.kind === 'ready') setView({ kind: 'ready', explanation: outcome.explanation });
      else if (outcome.kind === 'generating') setView({ kind: 'generating' });
      else setView({ kind: 'error', error: outcome.error });
    });

    return () => {
      alive = false;
    };
    // `data` is stable for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, lang, configured, attempt]);

  // B6: the finished row is PUSHED. Subscribed for the whole life of the
  // panel, not only while generating, so a row that lands between our request
  // and its reply is not missed.
  useEffect(() => {
    if (!configured) return;
    return stream.watchExplanation({ questionId, lang }, (pushed) => {
      // Only a finished one moves the screen. A `failed` push would otherwise
      // replace a perfectly good explanation with an error.
      if (pushed.status !== 'ready' || !pushed.body) return;
      setView({ kind: 'ready', explanation: pushed });
    });
    // `stream` is stable for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, lang, configured]);

  function send(next: FeedbackVote): void {
    // Optimistic: the thumb presses now. A lost vote is not worth an error
    // line on a screen the student opened to read an explanation.
    setVote(next);
    void data.vote({ questionId, lang, vote: next });
  }

  if (!configured) {
    return (
      <section className={`${CARD} flex flex-col gap-2`} data-testid="revision-panel">
        <Title mode={mode} />
        <p role="status" className="text-sm text-muted-foreground">
          {plain('revision.notConfigured', mode)}
        </p>
      </section>
    );
  }

  return (
    <section className={`${CARD} flex flex-col gap-3`} data-testid="revision-panel">
      <Title mode={mode} />

      {view.kind === 'loading' || view.kind === 'generating' ? (
        <Writing mode={mode} />
      ) : null}

      {view.kind === 'ready' ? (
        <Ready
          explanation={view.explanation}
          mode={mode}
          vote={vote}
          onVote={send}
        />
      ) : null}

      {view.kind === 'error' && view.error === 'no_plan' ? (
        <Upsell mode={mode} teacherExplanation={teacherExplanation} />
      ) : null}

      {view.kind === 'error' && view.error === 'limit' ? (
        <p
          data-testid="revision-limit"
          role="status"
          className="text-base text-muted-foreground"
        >
          {plain('revision.limit', mode)}
        </p>
      ) : null}

      {view.kind === 'error' && !OWN_SCREEN.includes(view.error) ? (
        <div data-testid="revision-error" className="flex flex-col items-start gap-2">
          <p role="status" className="text-base text-wrong">
            {plain(REVISION_ERROR_LABEL[view.error], mode)}
          </p>
          {/* `rate` and `ai_failed` are worth another tap. `sign_in`,
              `not_found` and `not_configured` are not, and a button that
              cannot help is worse than no button. */}
          {view.error === 'rate' || view.error === 'ai_failed' ? (
            <button
              type="button"
              data-testid="revision-retry"
              onClick={() => setAttempt((before) => before + 1)}
              className="min-h-12 rounded-[10px] border border-primary px-3 text-base font-medium text-primary"
            >
              {plain('revision.retry', mode)}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Title({ mode }: { mode: LangMode }) {
  return (
    <h2 className="flex items-center gap-2 text-base font-bold">
      <Sparkles aria-hidden="true" className="size-5 shrink-0 text-primary" />
      <span className="flex flex-col">
        {labels('revision.title', mode).map((line, index) => (
          <span key={line} className={index === 0 ? undefined : 'text-xs font-medium'}>
            {line}
          </span>
        ))}
      </span>
    </h2>
  );
}

/** The skeleton. DESIGN.md section 8: a skeleton PLUS the words. */
function Writing({ mode }: { mode: LangMode }) {
  return (
    <div
      data-testid="revision-loading"
      role="status"
      aria-busy="true"
      className="flex flex-col gap-2"
    >
      <p className="text-base text-muted-foreground">{plain('revision.writing', mode)}</p>
      {/* Three grey lines in the shape of the answer, so the screen does not
          jump when the real text arrives. */}
      {['w-1/2', 'w-full', 'w-5/6'].map((width) => (
        <span
          key={width}
          aria-hidden="true"
          data-testid="revision-skeleton"
          className={`block h-4 ${width} animate-pulse rounded-[10px] bg-border`}
        />
      ))}
    </div>
  );
}

function Ready({
  explanation,
  mode,
  vote,
  onVote,
}: {
  explanation: Explanation;
  mode: LangMode;
  vote: FeedbackVote | null;
  onVote: (next: FeedbackVote) => void;
}) {
  const body = explanation.body;
  if (!body) return null;

  return (
    <div data-testid="revision-ready" className="flex flex-col gap-3">
      {/* Exam . Topic chips, plus who wrote it. A teacher-corrected
          explanation must NOT be labelled AI (F-F7, issue 24). */}
      <div className="flex flex-wrap items-center gap-2">
        {body.exam ? (
          <span data-testid="revision-chip-exam" className={CHIP}>
            {body.exam}
          </span>
        ) : null}
        {body.topic ? (
          <span data-testid="revision-chip-topic" className={CHIP}>
            {body.topic}
          </span>
        ) : null}
        <span
          data-testid="revision-chip-author"
          className={`${CHIP} text-muted-foreground`}
        >
          {plain(
            explanation.editedByTeacher ? 'revision.byTeacher' : 'revision.aiWritten',
            mode,
          )}
        </span>
      </div>

      {/* The question in short. */}
      {body.question ? (
        <p data-testid="revision-question" className="text-[17px] leading-[26px] font-medium">
          {body.question}
        </p>
      ) : null}

      {/* Sections with headings, so a student can skim to the part they need. */}
      {body.sections.map((section, index) => (
        <div
          key={`${index}-${section.heading}`}
          data-testid="revision-section"
          className="flex flex-col gap-1"
        >
          <h3 className="text-base font-bold">{section.heading}</h3>
          <p className="text-base whitespace-pre-line text-foreground">{section.body}</p>
        </div>
      ))}

      {/* The Remember box: the one line to carry into the exam hall. */}
      {body.remember ? (
        <div
          data-testid="revision-remember"
          className="flex flex-col gap-1 rounded-[10px] border border-marked bg-card p-3"
        >
          <h3 className="text-sm font-bold text-marked">
            {plain('revision.remember', mode)}
          </h3>
          <p className="text-base">{body.remember}</p>
        </div>
      ) : null}

      {/* Sources, as real links. `rel` set because they leave the app. */}
      {explanation.sources.length > 0 ? (
        <div data-testid="revision-sources" className="flex flex-col gap-1">
          <h3 className="text-sm font-bold text-muted-foreground">
            {plain('revision.sources', mode)}
          </h3>
          <ul className="flex flex-col gap-1">
            {explanation.sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-h-12 items-center gap-2 text-base text-primary underline"
                >
                  <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
                  {source.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The audio bar, under Sources, exactly where DESIGN.md section 8 puts
          it. Only when there is a file: audio is made in the background after
          the text is saved (issue 25-revision-audio). */}
      {explanation.audioPath ? (
        <RevisionAudioBar
          questionId={explanation.questionId}
          lang={explanation.lang}
          mode={mode}
        />
      ) : null}

      {/* Thumbs up / down. The vote goes to the teacher (DESIGN.md section 8). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <button
          type="button"
          data-testid="revision-thumb-up"
          aria-pressed={vote === 'up'}
          aria-label={plain('revision.thumbsUp', mode)}
          onClick={() => onVote('up')}
          className={`${THUMB} ${
            vote === 'up' ? 'border-correct-icon text-correct' : 'border-border text-muted-foreground'
          }`}
        >
          <ThumbsUp aria-hidden="true" className="size-5" />
        </button>
        <button
          type="button"
          data-testid="revision-thumb-down"
          aria-pressed={vote === 'down'}
          aria-label={plain('revision.thumbsDown', mode)}
          onClick={() => onVote('down')}
          className={`${THUMB} ${
            vote === 'down' ? 'border-wrong-icon text-wrong' : 'border-border text-muted-foreground'
          }`}
        >
          <ThumbsDown aria-hidden="true" className="size-5" />
        </button>
        {vote ? (
          <p
            data-testid="revision-feedback"
            role="status"
            className="text-sm text-muted-foreground"
          >
            {plain('revision.feedbackThanks', mode)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** No plan: one card, and the teacher's own words stay on screen. */
function Upsell({
  mode,
  teacherExplanation,
}: {
  mode: LangMode;
  teacherExplanation: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="revision-upsell"
        className="flex flex-col items-start gap-2 rounded-[10px] border border-primary bg-card p-3"
      >
        <p className="text-base font-medium">{plain('revision.noPlan', mode)}</p>
        <Link
          href={PLANS_PATH}
          prefetch={false}
          className="inline-flex min-h-12 items-center justify-center rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground"
        >
          {plain('revision.subscribe', mode)}
        </Link>
      </div>

      {/* The DoD: "the teacher explanation stays visible". */}
      {teacherExplanation ? (
        <div data-testid="revision-teacher" className="flex flex-col gap-1">
          <h3 className="text-sm font-bold text-muted-foreground">
            {plain('player.explanation', mode)}
          </h3>
          <p className="text-base text-muted-foreground">{teacherExplanation}</p>
        </div>
      ) : null}
    </div>
  );
}
