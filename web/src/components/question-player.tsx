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
import { Bookmark, BookmarkCheck, Check, Eye, ListChecks, Sparkles, WifiOff, X } from 'lucide-react';
import { EmptyState } from '@/components/student-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RevisionPanel } from '@/components/revision-panel';
import {
  explanationLang,
  type BrowserRevisionClient,
  type ExplanationLive,
} from '@/lib/ai/revision-screen';
import {
  optionLetter,
  progressLabel,
  verdictOf,
  type AnswerQueue,
  type AttemptAnswer,
} from '@/lib/attempts/types';
import {
  DEFAULT_MARKING,
  scoreAnswers,
  totalMarks,
  type Marking,
} from '@/lib/practice/types';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import type { Question } from '@/lib/questions/types';
import type { SavedTag } from '@/lib/saved/types';

/** What one option button looks like. Never colour on its own. */
type OptionState = 'idle' | 'right' | 'wrong';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/**
 * Outline options (DESIGN.md section 0), 56 px tall (`min-h-14`), full width,
 * 8 px apart. The state classes come from tokens, never a raw hex.
 */
const OPTION_BASE =
  'flex min-h-14 w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left ' +
  'text-base leading-6 transition-colors duration-100 hover:border-primary';

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
  marking = DEFAULT_MARKING,
  startedAnswers,
  onFinish,
  onTag,
  revisionClient,
  revisionLive,
  revisionConfigured = true,
}: {
  /** Every question of the paper, in order. Loaded in ONE request. */
  questions: readonly Question[];
  attemptId: string;
  /** The offline retry queue. The player never calls `fetch` itself. */
  queue: AnswerQueue;
  mode?: LangMode;
  /** The exam name above the progress bar, 14 px muted (DESIGN.md section 8). */
  examName?: string;
  /**
   * F-E6, marking per exam (issue 17-practice-mode). The score is MARKS, so
   * CUET PG at +4 and -1 turns 10 right and 5 wrong into 35, not 10.
   *
   * Defaults to one mark a question with no negative marking, which is what a
   * past paper and an exam with no published scheme get, and is exactly what
   * this player showed before that slice.
   */
  marking?: Marking;
  /** Answers already in this sitting, so re-opening resumes where it was. */
  startedAnswers?: ReadonlyMap<string, AttemptAnswer>;
  /** Called once, with the score, when the student finishes. */
  onFinish?: (score: number) => void | Promise<void>;
  /**
   * The Saved list sink (issue 14-saved-list, PRD F-E8). A wrong answer saves
   * itself with the tag `wrong`; Mark for later saves `marked` and un-marking
   * removes it. Optional, and never awaited: a dead network must not stop the
   * student answering the next question. The write is keyed
   * `(user_id, question_id, tag)`, so the same tag sent twice is one row.
   */
  onTag?: (questionId: string, tag: SavedTag, saved: boolean) => void;
  /**
   * The Revision (AI) screen's two outside things (issue 23-revision-screen).
   * Passed straight through, so this file's own test drives the panel with no
   * `fetch` and no socket. Left out in the app: the panel builds the real ones
   * itself, lazily.
   */
  revisionClient?: BrowserRevisionClient;
  revisionLive?: ExplanationLive;
  /** False when the Supabase env vars are missing. */
  revisionConfigured?: boolean;
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
    return <EmptyState Icon={ListChecks} text={plain('player.none', mode)} />;
  }

  const answer = answers.get(question.id);
  const answered = answer?.chosenIdx !== null && answer?.chosenIdx !== undefined;
  const isRevealed = revealed.has(question.id);
  const marked = answer?.marked === true;
  const isCorrect = answer?.isCorrect === true;
  const last = index >= total - 1;

  // THE ANSWER KEY, or -1 (issue 30-exam-key-lock). `Question.correctIdx` is
  // nullable now, because the column is only readable through
  // `question_keys()` and that refuses it mid-exam. It CANNOT be null here:
  // the practice page never renders this player without the keys. -1 is not
  // an option index, so even then nothing is painted right and nothing is
  // marked correct, which is the safe way round.
  const key = question.correctIdx ?? -1;

  function optionState(optionIdx: number): OptionState {
    // Nothing is coloured until the student has answered or asked to see it.
    if (!answered && !isRevealed) return 'idle';
    if (optionIdx === key) return 'right';
    if (answered && optionIdx === answer?.chosenIdx) return 'wrong';
    return 'idle';
  }

  function choose(optionIdx: number): void {
    const right = verdictOf(key, optionIdx);
    store(question.id, { chosenIdx: optionIdx, isCorrect: right, marked });
    // F-E8: a wrong answer saves itself under the tag Wrong. A right answer
    // saves nothing, and it does NOT take an earlier Wrong row away: the
    // student decides that with Remove in the Saved tab.
    if (!right) onTag?.(question.id, 'wrong', true);
    setRevisionAsked(false);
  }

  function toggleMark(): void {
    const wanted = !marked;
    store(question.id, {
      chosenIdx: answer?.chosenIdx ?? null,
      isCorrect: answer?.isCorrect ?? null,
      marked: wanted,
    });
    // The mark lives in two places on purpose: on the answer, which is this
    // sitting's question grid, and in the Saved list, which outlives the
    // sitting. Un-marking takes the saved row away again.
    onTag?.(question.id, 'marked', wanted);
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
    // Marks, not a count of right answers (F-E6). The same number goes on the
    // screen and into `attempts.score`, so the student and the mock list can
    // never disagree.
    const score = scoreAnswers(answers, marking);
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

      <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-1 border-b border-border bg-background px-4 py-2 md:-mx-6 md:px-6">
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
                    className="flex size-8 shrink-0 items-center justify-center rounded-full border border-current text-base leading-6 font-bold"
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

            {/* The AI explanation, on the SAME screen under the result (D3).
                Mounted only when the student asks, so no model call and no
                socket happens for a student who never taps Revision. The
                `key` remounts it per question and language, which is what
                starts the one request for the new question. */}
            {revisionAsked ? (
              <RevisionPanel
                key={`${question.id}:${explanationLang(mode, question.lang)}`}
                questionId={question.id}
                lang={explanationLang(mode, question.lang)}
                mode={mode}
                teacherExplanation={question.teacherExplanation}
                client={revisionClient}
                live={revisionLive}
                configured={revisionConfigured}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Sticky bottom action bar (DESIGN.md section 5), with the safe area. */}
      <div
        className="sticky bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom))] z-10 -mx-4 grid grid-cols-2 items-stretch gap-2 border-t border-border bg-background px-4 py-2 md:-mx-6 md:px-6"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}
      >
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          className={`${QUIET} order-1`}
        >
          {plain('player.prev', mode)}
        </button>

        {/* Wrong answer: Revision (AI) is the primary action. Right answer and
            unanswered: Mark for later (DESIGN.md section 8). */}
        {answered && !isCorrect ? (
          <button
            type="button"
            onClick={() => setRevisionAsked(true)}
            className={`${PRIMARY} order-3 col-span-2`}
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
            className={`${marked ? `${OUTLINE} border-marked text-marked` : OUTLINE} order-3`}
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
          <button type="button" onClick={reveal} className={`${OUTLINE} order-4`}>
            <Eye aria-hidden="true" className="size-5" />
            {plain('player.reveal', mode)}
          </button>
        ) : null}

        {last ? (
          finished ? (
            <p
              data-testid="player-score"
              role="status"
              className="order-2 text-right text-base font-bold tabular-nums"
            >
              {plain('player.score', mode)} {scoreAnswers(answers, marking)} /{' '}
              {totalMarks(total, marking)}
            </p>
          ) : (
            <button type="button" onClick={finish} className={`${PRIMARY} order-2`}>
              {plain('player.finish', mode)}
            </button>
          )
        ) : (
          <button type="button" onClick={() => go(1)} className={`${PRIMARY} order-2`}>
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
