'use client';

/**
 * The question player (issue 13-question-player).
 *
 * One component for past papers now and for mock tests later (issues 17 and
 * 18), which is why the answers live in a map keyed by question id and not in
 * an array of this paper's shape.
 *
 * D3, THE LOCKED DECISION: the result shows on the SAME screen, under the
 * options, with no page load. So this is a client component and every question
 * of the paper is already in `questions`: the player never waits for a network
 * round trip between two questions (DESIGN.md section 10, "a test loads in 1
 * request"). The page above hands the whole array down.
 *
 * COLOUR NEVER WORKS ALONE (DESIGN.md section 3). Every verdict is an icon AND
 * a word: a green tick and "Correct", a red cross and "Wrong". The options
 * carry the same pair, so a colour-blind student reads the same answer as
 * everybody else.
 *
 * WRITES GO THROUGH THE QUEUE, never straight to `fetch`. An answer given with
 * no network is kept and sent when the network comes back (DESIGN.md section
 * 9). The write itself is an upsert keyed `(attempt_id, question_id)`, so a
 * repeat is harmless (A1).
 *
 * A11y: options are real `<button>`s, 56 px tall, the result is announced with
 * `aria-live="polite"`, and every icon-only control has an `aria-label` in the
 * current language.
 */
import { Bookmark, BookmarkCheck, Check, Eye, Sparkles, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  countCorrect,
  optionLetter,
  progressLabel,
  verdictOf,
  type AnswerQueue,
  type AttemptAnswer,
} from '@/lib/attempts/types';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import type { Question } from '@/lib/questions/types';

/** What one option button looks like. Never colour on its own. */
type OptionState = 'idle' | 'right' | 'wrong';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/**
 * Outline options (DESIGN.md section 0), 56 px tall (`min-h-14`), full width,
 * 8 px apart. The state classes come from tokens, never a raw hex.
 */
const OPTION_BASE =
  'flex min-h-14 w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left ' +
  'text-base transition-colors duration-100';

const OPTION_STATE: Record<OptionState, string> = {
  idle: 'border-border bg-card text-foreground',
  right: 'border-correct-icon bg-correct-soft text-correct',
  wrong: 'border-wrong-icon bg-wrong-soft text-wrong',
};

const BUTTON_BASE =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] px-3 ' +
  'text-base font-medium transition-colors duration-100 disabled:opacity-50';

const PRIMARY = `${BUTTON_BASE} bg-primary text-primary-foreground`;
const OUTLINE = `${BUTTON_BASE} border border-primary text-primary`;
const QUIET = `${BUTTON_BASE} border border-border text-muted-foreground`;

export function QuestionPlayer({
  questions,
  attemptId,
  queue,
  mode = DEFAULT_MODE,
  examName,
  startedAnswers,
  onFinish,
}: {
  /** Every question of the paper, in order. Loaded in ONE request. */
  questions: readonly Question[];
  attemptId: string;
  /** The offline retry queue. The player never calls `fetch` itself. */
  queue: AnswerQueue;
  mode?: LangMode;
  /** The exam name above the progress bar, 14 px muted (DESIGN.md section 8). */
  examName?: string;
  /** Answers already in this sitting, so re-opening resumes where it was. */
  startedAnswers?: ReadonlyMap<string, AttemptAnswer>;
  /** Called once, with the score, when the student finishes. */
  onFinish?: (score: number) => void | Promise<void>;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, AttemptAnswer>>(
    () => new Map(startedAnswers ?? []),
  );
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [revisionAsked, setRevisionAsked] = useState(false);
  const [finished, setFinished] = useState(false);
  // Starts optimistic, so the server-rendered markup and the first client
  // render agree. The effect below corrects it on mount.
  const [online, setOnline] = useState(true);
  const [waiting, setWaiting] = useState(0);

  const total = questions.length;
  const question = questions[Math.min(index, Math.max(total - 1, 0))];

  // The browser tells us, we never poll. `online` also retries the queue,
  // which is the whole point of keeping one.
  useEffect(() => {
    function up() {
      setOnline(true);
      void queue.flush();
    }
    function down() {
      setOnline(false);
    }

    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [queue]);

  // How many answers are still held, so the banner can say so.
  useEffect(() => {
    setWaiting(queue.pending());
    return queue.subscribe(() => setWaiting(queue.pending()));
  }, [queue]);

  const store = useCallback(
    (questionId: string, next: AttemptAnswer) => {
      setAnswers((before) => {
        const after = new Map(before);
        after.set(questionId, next);
        return after;
      });
      // One upsert per change, keyed by attempt and question. `push` never
      // throws, so a dead network cannot break the screen.
      void queue.push({ attemptId, questionId, ...next });
    },
    [attemptId, queue],
  );

  if (total === 0 || !question) {
    return (
      <p role="status" className="text-muted-foreground">
        {plain('player.none', mode)}
      </p>
    );
  }

  const answer = answers.get(question.id);
  const answered = answer?.chosenIdx !== null && answer?.chosenIdx !== undefined;
  const isRevealed = revealed.has(question.id);
  const marked = answer?.marked === true;
  const isCorrect = answer?.isCorrect === true;
  const last = index >= total - 1;

  function optionState(optionIdx: number): OptionState {
    // Nothing is coloured until the student has answered or asked to see it.
    if (!answered && !isRevealed) return 'idle';
    if (optionIdx === question.correctIdx) return 'right';
    if (answered && optionIdx === answer?.chosenIdx) return 'wrong';
    return 'idle';
  }

  function choose(optionIdx: number): void {
    store(question.id, {
      chosenIdx: optionIdx,
      isCorrect: verdictOf(question.correctIdx, optionIdx),
      marked,
    });
    setRevisionAsked(false);
  }

  function toggleMark(): void {
    store(question.id, {
      chosenIdx: answer?.chosenIdx ?? null,
      isCorrect: answer?.isCorrect ?? null,
      marked: !marked,
    });
  }

  function reveal(): void {
    // A reveal is NOT an answer: nothing is scored and nothing is stored, so
    // a student who peeked does not end up with a wrong row in their attempt.
    setRevealed((before) => new Set(before).add(question.id));
  }

  function go(step: number): void {
    setIndex((before) => Math.min(Math.max(before + step, 0), total - 1));
    setRevisionAsked(false);
  }

  function finish(): void {
    const score = countCorrect(answers);
    setFinished(true);
    void Promise.resolve(onFinish?.(score)).catch(() => {
      // The score is on screen either way. A failed submit is retried by the
      // student reopening the paper, not by a crash here.
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* DESIGN.md section 9: one line, at the top, while the net is down. */}
      {!online ? (
        <p
          data-testid="player-offline"
          role="status"
          className={`${CARD} flex items-center gap-2 border-marked text-sm text-marked`}
        >
          <WifiOff aria-hidden="true" className="size-5 shrink-0" />
          <span>{plain('player.offline', mode)}</span>
          {waiting > 0 ? <span className="tabular-nums">{waiting}</span> : null}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        {examName ? (
          <p className="text-sm font-medium text-muted-foreground">{examName}</p>
        ) : null}

        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={plain('player.progress', mode)}
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={Math.min(index + 1, total)}
            aria-valuetext={progressLabel(index, total)}
            className="h-2 grow overflow-hidden rounded-full bg-border"
          >
            <span
              className="block h-full bg-primary"
              style={{ width: `${((index + 1) / total) * 100}%` }}
            />
          </div>
          <p
            data-testid="player-progress"
            className="shrink-0 text-sm font-medium tabular-nums"
          >
            {progressLabel(index, total)}
          </p>
        </div>
      </div>

      <div className={`${CARD} flex flex-col gap-3`}>
        <p className="text-[17px] leading-[26px] font-medium">{question.stem}</p>

        <ul className="flex flex-col gap-2">
          {question.options.map((text, optionIdx) => {
            const state = optionState(optionIdx);
            return (
              <li key={optionIdx}>
                <button
                  type="button"
                  data-testid="player-option"
                  data-state={state}
                  aria-pressed={answered ? answer?.chosenIdx === optionIdx : undefined}
                  onClick={() => choose(optionIdx)}
                  className={`${OPTION_BASE} ${OPTION_STATE[state]}`}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full border border-current text-sm font-medium"
                  >
                    {optionLetter(optionIdx)}
                  </span>
                  <span className="grow">{text}</span>

                  {/* Icon AND word, so the green and the red never stand alone. */}
                  {state === 'right' ? (
                    <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
                      <Check aria-hidden="true" className="size-5" />
                      {plain('player.rightOption', mode)}
                    </span>
                  ) : null}
                  {state === 'wrong' ? (
                    <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
                      <X aria-hidden="true" className="size-5" />
                      {plain('player.yourOption', mode)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        {/* D3: the result, on the same screen, under the options. */}
        {answered || isRevealed ? (
          <div
            data-testid="player-result"
            aria-live="polite"
            className="flex flex-col gap-3"
          >
            {answered ? (
              <p
                className={`flex items-center gap-2 text-base font-bold ${
                  isCorrect ? 'text-correct' : 'text-wrong'
                }`}
              >
                <span data-icon={isCorrect ? 'correct' : 'wrong'} className="flex">
                  {isCorrect ? (
                    <Check aria-hidden="true" className="size-6" />
                  ) : (
                    <X aria-hidden="true" className="size-6" />
                  )}
                </span>
                {plain(isCorrect ? 'player.correct' : 'player.wrong', mode)}
              </p>
            ) : (
              // Revealed but not answered: there is no verdict to give.
              <p className="flex items-center gap-2 text-base font-bold text-correct">
                <span data-icon="answer" className="flex">
                  <Eye aria-hidden="true" className="size-6" />
                </span>
                {plain('player.answer', mode)}
              </p>
            )}

            {/* Closed accordion: a plain <details>, so it works with no JS and
                the student decides when to read it. */}
            <details
              data-testid="player-explanation"
              className="rounded-[10px] border border-border p-3"
            >
              <summary className="min-h-12 cursor-pointer list-none text-base font-medium">
                {plain('player.explanation', mode)}
              </summary>
              <p className="pt-2 text-base text-muted-foreground">
                {question.teacherExplanation ?? plain('player.noExplanation', mode)}
              </p>
            </details>

            {/* Issue 23 writes the explanation. Until then the button is here
                and says so, rather than being missing and surprising later. */}
            {revisionAsked ? (
              <p
                data-testid="player-revision-soon"
                role="status"
                className="text-sm text-muted-foreground"
              >
                {plain('placeholder.soon', mode)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Sticky bottom action bar (DESIGN.md section 5), with the safe area. */}
      <div
        className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-background py-2"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}
      >
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          className={QUIET}
        >
          {plain('player.prev', mode)}
        </button>

        {/* Wrong answer: Revision (AI) is the primary action. Right answer and
            unanswered: Mark for later (DESIGN.md section 8). */}
        {answered && !isCorrect ? (
          <button
            type="button"
            onClick={() => setRevisionAsked(true)}
            className={`${PRIMARY} grow`}
          >
            <Sparkles aria-hidden="true" className="size-5" />
            {plain('player.revision', mode)}
          </button>
        ) : (
          <button
            type="button"
            data-testid="player-mark"
            aria-pressed={marked}
            onClick={toggleMark}
            className={marked ? `${OUTLINE} border-marked text-marked` : OUTLINE}
          >
            {marked ? (
              <BookmarkCheck aria-hidden="true" className="size-5" />
            ) : (
              <Bookmark aria-hidden="true" className="size-5" />
            )}
            {plain('player.mark', mode)}
          </button>
        )}

        {/* Past papers only, and only while the answer is still a secret. */}
        {!answered && !isRevealed ? (
          <button type="button" onClick={reveal} className={OUTLINE}>
            <Eye aria-hidden="true" className="size-5" />
            {plain('player.reveal', mode)}
          </button>
        ) : null}

        {last ? (
          finished ? (
            <p
              data-testid="player-score"
              role="status"
              className="grow text-right text-base font-bold tabular-nums"
            >
              {plain('player.score', mode)} {countCorrect(answers)} / {total}
            </p>
          ) : (
            <button type="button" onClick={finish} className={`${PRIMARY} grow`}>
              {plain('player.finish', mode)}
            </button>
          )
        ) : (
          <button type="button" onClick={() => go(1)} className={`${PRIMARY} grow`}>
            <span className="flex flex-col items-center">
              {labels('player.next', mode).map((line, lineIdx) => (
                <span key={line} className={lineIdx === 0 ? undefined : 'text-xs'}>
                  {line}
                </span>
              ))}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
