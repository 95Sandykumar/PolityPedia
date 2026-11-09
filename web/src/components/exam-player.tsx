'use client';

/**
 * The TIMED exam player (issue 18-exam-mode).
 *
 * Its own component, not a flag on `QuestionPlayer` from issue 13, and F-E5 is
 * the reason: this player is handed `ExamQuestion`s, which HAVE NO
 * `correctIdx` and no `teacherExplanation`. It cannot show a right answer
 * early because it does not have one. A boolean on the practice player would
 * have left the key sitting in the props of a component one `if` away from
 * drawing it.
 *
 * WHAT IS ON SCREEN (DESIGN.md section 8):
 *
 *  * The exam name, the progress bar and "12 / 100", with the TIMER top right.
 *    The timer turns amber under 5 minutes and stops at 00:00.
 *  * Tapping the progress bar opens the QUESTION-NUMBER GRID: answered, marked
 *    and not seen (D2, locked).
 *  * Four option buttons, 56 px tall, with a letter badge. The only feedback
 *    before submit is which one is chosen.
 *  * After submit: the score the SERVER worked out, then the right answers and
 *    the explanations, which arrived in a RE-READ of the load route.
 *
 * COLOUR NEVER WORKS ALONE (DESIGN.md section 3). The timer carries a word
 * when time is up, every grid square has an `aria-label` naming its state, the
 * grid has a legend, and each reviewed option carries an icon and a word.
 *
 * THE CLOCK HERE IS A COURTESY. `attempt_answers_insert_open` and
 * `attempt_answers_update_open` in `0018_exam_mode.sql` are what actually
 * refuse a late answer, so a student who changes the device clock gets a
 * prettier countdown and writes nothing.
 */
import { Check, Clock, LayoutGrid, ListChecks, X } from 'lucide-react';
import { AttemptResultPanel } from '@/components/attempt-result';
import { EmptyState } from '@/components/student-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserResultReader } from '@/lib/attempts/browser-result-client';
import {
  optionLetter,
  progressLabel,
  type AttemptAnswer,
  type AttemptResult,
} from '@/lib/attempts/types';
import {
  gridState,
  remainingMs,
  timerLabel,
  timerTone,
  type BrowserExamClient,
  type ExamQuestion,
  type GridState,
} from '@/lib/exam/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';
import { DEFAULT_MARKING, totalMarks, type Marking } from '@/lib/practice/types';
import type { Question } from '@/lib/questions/types';

/** What one option button looks like. Never colour on its own. */
type OptionState = 'idle' | 'chosen' | 'right' | 'wrong';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

const OPTION_BASE =
  'flex min-h-14 w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left ' +
  'text-base leading-6 transition-colors duration-100';

const OPTION_STATE: Record<OptionState, string> = {
  idle: 'border-border bg-card text-foreground',
  // Before submit the ONLY state a tap produces: chosen. Not right, not wrong.
  chosen: 'border-primary bg-primary/5 text-foreground ring-1 ring-primary',
  right: 'border-correct-icon bg-correct-soft text-correct',
  wrong: 'border-wrong-icon bg-wrong-soft text-wrong',
};

const BUTTON_BASE =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] px-3 ' +
  'text-base font-medium transition-colors duration-100 disabled:opacity-50';

const PRIMARY = `${BUTTON_BASE} bg-primary text-primary-foreground`;
const OUTLINE = `${BUTTON_BASE} border border-primary text-primary`;
const QUIET = `${BUTTON_BASE} border border-border text-muted-foreground`;

/** The timer's three tones, as tokens. Amber is the `marked` token (#b45309). */
const TONE_CLASS = {
  calm: 'text-foreground',
  amber: 'text-marked',
  over: 'text-wrong',
} as const;

/** The grid squares. Each one also carries a word, in `aria-label`. */
const SQUARE_STATE: Record<GridState, string> = {
  answered: 'border-primary bg-primary text-primary-foreground',
  marked: 'border-marked text-marked',
  unseen: 'border-border text-muted-foreground',
};

const GRID_LABEL: Record<GridState, 'exam.answered' | 'exam.marked' | 'exam.unseen'> = {
  answered: 'exam.answered',
  marked: 'exam.marked',
  unseen: 'exam.unseen',
};

export function ExamPlayer({
  questions,
  attemptId,
  deadlineAt,
  mode = DEFAULT_MODE,
  examName,
  marking = DEFAULT_MARKING,
  startedAnswers,
  revealed = false,
  score = null,
  readResult,
  nextHref = null,
  client,
  now = Date.now,
}: {
  /**
   * Every question of the paper, in order, loaded in ONE request. STRIPPED of
   * the answer key while the sitting is open (F-E5), so the type is the wider
   * one: a plain `Question` only arrives once the paper is in.
   */
  questions: readonly (Question | ExamQuestion)[];
  attemptId: string;
  /** When the clock runs out. Null means no clock, and then none is drawn. */
  deadlineAt: string | null;
  mode?: LangMode;
  /** The exam name above the progress bar, 14 px muted (DESIGN.md section 8). */
  examName?: string;
  /** F-E6: the score is MARKS, which is what the paper is out of. */
  marking?: Marking;
  /** Answers already in this sitting, so re-opening resumes where it was. */
  startedAnswers?: readonly (readonly [string, AttemptAnswer])[];
  /** True when the sitting was ALREADY submitted: the page opens in review. */
  revealed?: boolean;
  /** The stored score of a sitting that was already submitted. */
  score?: number | null;
  /**
   * The RESULT PAGE's read (issue 56-result-page). Asked once, after the close,
   * and its answer replaces the one-line score with the breakdown: the counts,
   * the time taken and the questions that went wrong.
   *
   * Optional, and a null answer is not an error: the stored score is already
   * on the sticky bar, so a sitting whose breakdown will not load still shows
   * the mark the server gave.
   */
  readResult?: BrowserResultReader;
  /** Where the result page's "Next test" goes. Null draws no link. */
  nextHref?: string | null;
  /** Our own routes. Holds no key, and never marks anything itself. */
  client: BrowserExamClient;
  /** Injected so a test can pin the clock. */
  now?: () => number;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, AttemptAnswer>>(
    () => new Map(startedAnswers ?? []),
  );
  const [gridOpen, setGridOpen] = useState(false);
  const [submitted, setSubmitted] = useState(revealed);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [finalScore, setFinalScore] = useState<number | null>(revealed ? score : null);
  /** The result page, once the read behind it answers. Null until then. */
  const [result, setResult] = useState<AttemptResult | null>(null);
  /**
   * The questions WITH the key. Null until the paper is in, which is the whole
   * of "strip until submit": there is no state of this component before submit
   * in which the key exists.
   */
  const [keyed, setKeyed] = useState<readonly Question[] | null>(
    revealed ? (questions as readonly Question[]) : null,
  );
  const [left, setLeft] = useState<number | null>(() => remainingMs(deadlineAt, now()));

  const total = questions.length;
  const question = questions[Math.min(index, Math.max(total - 1, 0))];
  /** The same question with its key, once there is one. Matched by ID. */
  const reviewed = useMemo(
    () => (question ? (keyed?.find((one) => one.id === question.id) ?? null) : null),
    [keyed, question],
  );

  /**
   * Close the sitting. The SERVER marks it, so there is no score worked out
   * here, and the review is a RE-READ of the same route that stripped the key.
   *
   * THE LATCH IS A REF, NOT THE `submitting` STATE. Two taps in the same tick
   * both read the old state, because React has not re-rendered in between, so
   * a state guard lets the second one through. `score_attempt()` would hand
   * back the same number either way, but a second request on a 4G connection
   * is a second chance for the screen to flicker.
   */
  const sending = useRef(false);
  const submit = useCallback(async () => {
    if (submitted || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const got = await client.submit(attemptId);
      setFinalScore(got);
      setSubmitted(true);
      // The key arrives HERE, after the sitting is closed, and only because
      // Postgres now has a `submitted_at`.
      const fresh = await client.load().catch(() => null);
      if (fresh?.revealed) setKeyed(fresh.questions as readonly Question[]);
    } catch {
      // The paper is still on screen and the answers are stored, so the
      // student simply taps Submit again. The latch opens for that.
      sending.current = false;
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, client, submitted]);

  // The clock. One interval, and it stops itself once the paper is in.
  useEffect(() => {
    if (deadlineAt === null || submitted) return;

    setLeft(remainingMs(deadlineAt, now()));
    const tick = setInterval(() => {
      setLeft(remainingMs(deadlineAt, now()));
    }, 1000);
    return () => clearInterval(tick);
  }, [deadlineAt, now, submitted]);

  // Time up: submit by itself. Postgres has stopped taking answers at exactly
  // this moment, so leaving the paper open would be a screen that lies.
  //
  // ITS OWN REF, on top of the latch in `submit`. A FAILED auto-submit opens
  // that latch again so the student can tap Submit, and `left` is still 0, so
  // without this one the effect would retry for ever on a dead network.
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (left !== 0 || submitted || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void submit();
  }, [left, submit, submitted]);

  /**
   * The result page (issue 56-result-page).
   *
   * ASKED ONCE, and the ref is why: a null answer means "nothing to show", and
   * without the latch the effect would ask again on the next render for ever.
   * It fires for BOTH ways a sitting closes, the student's Submit and the
   * clock's, because `submitted` is what it watches, and for a sitting that
   * was already closed when the page opened (`revealed`), which is how a
   * student who was knocked offline at the deadline sees the same page.
   *
   * The read runs on the server with the student's own token, so `right` and
   * `wrong` here are Postgres's answer, not this component's (0031).
   */
  const askedResult = useRef(false);
  useEffect(() => {
    if (!submitted || !readResult || askedResult.current) return;
    askedResult.current = true;

    let alive = true;
    void readResult(attemptId).then((got) => {
      if (alive && got) setResult(got);
    });
    return () => {
      alive = false;
    };
  }, [attemptId, readResult, submitted]);

  const store = useCallback(
    (questionId: string, next: AttemptAnswer) => {
      setAnswers((before) => {
        const after = new Map(before);
        after.set(questionId, next);
        return after;
      });
      // One upsert per change, keyed by attempt and question (A1). Never
      // awaited and never thrown: a dead network must not stop the paper, and
      // the answer is already on screen.
      void client
        .saveAnswer({
          attemptId,
          questionId,
          chosenIdx: next.chosenIdx,
          marked: next.marked,
        })
        .catch(() => {});
    },
    [attemptId, client],
  );

  if (total === 0 || !question) {
    return <EmptyState Icon={ListChecks} text={plain('player.none', mode)} />;
  }

  const answer = answers.get(question.id);
  const chosen = answer?.chosenIdx ?? null;
  const marked = answer?.marked === true;
  const last = index >= total - 1;
  const tone = timerTone(left);

  function optionState(optionIdx: number): OptionState {
    // THE REVIEW, and only the review, can say right or wrong.
    if (submitted && reviewed) {
      if (optionIdx === reviewed.correctIdx) return 'right';
      if (chosen === optionIdx) return 'wrong';
      return 'idle';
    }
    return chosen === optionIdx ? 'chosen' : 'idle';
  }

  function choose(optionIdx: number): void {
    // A closed paper takes nothing more, the same rule Postgres enforces.
    if (submitted) return;
    store(question.id, { chosenIdx: optionIdx, isCorrect: null, marked });
  }

  function toggleMark(): void {
    if (submitted) return;
    store(question.id, { chosenIdx: chosen, isCorrect: null, marked: !marked });
  }

  function go(step: number): void {
    setIndex((before) => Math.min(Math.max(before + step, 0), total - 1));
  }

  function jump(to: number): void {
    setIndex(Math.min(Math.max(to, 0), total - 1));
    setGridOpen(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-1 border-b border-border bg-background px-4 py-2 md:-mx-6 md:px-6">
        {examName ? (
          <p className="text-sm font-medium text-muted-foreground">{examName}</p>
        ) : null}

        <div className="flex items-center gap-3">
          {/* D2: the progress bar IS the way into the grid. */}
          <button
            type="button"
            data-testid="exam-progress-open"
            aria-label={plain('exam.gridOpen', mode)}
            aria-expanded={gridOpen}
            onClick={() => setGridOpen((before) => !before)}
            className="flex min-h-11 grow items-center"
          >
            <span
              role="progressbar"
              aria-label={plain('player.progress', mode)}
              aria-valuemin={1}
              aria-valuemax={total}
              aria-valuenow={Math.min(index + 1, total)}
              aria-valuetext={progressLabel(index, total)}
              className="block h-2 w-full overflow-hidden rounded-full bg-border"
            >
              <span
                className="block h-full bg-primary"
                style={{ width: `${((index + 1) / total) * 100}%` }}
              />
            </span>
          </button>

          <p
            data-testid="exam-progress"
            className="shrink-0 text-sm font-medium tabular-nums"
          >
            {progressLabel(index, total)}
          </p>

          {/* The timer, top RIGHT, amber under 5 minutes. */}
          {left !== null ? (
            <p
              data-testid="exam-timer"
              // The clock text comes from Date.now(), so the server and the
              // browser are a second apart on first paint. Expected, not a bug.
              suppressHydrationWarning
              data-tone={tone}
              role="timer"
              aria-label={plain('exam.timeLeft', mode)}
              className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-base font-bold tabular-nums ${TONE_CLASS[tone]} ${tone === 'calm' ? 'border-border' : 'border-current'}`}
            >
              <Clock aria-hidden="true" className="size-5" />
              {timerLabel(left)}
            </p>
          ) : null}
        </div>
      </div>

      {/* The payoff moment (issue 56-result-page). It REPLACES the one-line
          score in the bottom bar, and it sits at the top of the paper because
          it is what the student came back for; the questions below it are
          still there for the review. */}
      {result ? (
        <AttemptResultPanel
          result={result}
          mode={mode}
          // F-E6: the paper is out of MARKS, not questions.
          outOf={totalMarks(total, marking)}
          nextHref={nextHref}
        />
      ) : null}

      {/* Colour never works alone: time up is also a sentence. */}
      {tone === 'over' && !submitted ? (
        <p role="status" className={`${CARD} border-wrong text-sm text-wrong`}>
          {plain('exam.timeUp', mode)}
        </p>
      ) : null}

      {/* D2: the question-number grid. */}
      {gridOpen ? (
        <div
          data-testid="exam-grid"
          role="dialog"
          aria-label={plain('exam.grid', mode)}
          className={`${CARD} flex flex-col gap-3`}
        >
          <ul className="flex flex-wrap gap-2">
            {questions.map((one, questionIdx) => {
              const state = gridState(answers.get(one.id));
              return (
                <li key={one.id}>
                  <button
                    type="button"
                    data-testid="exam-grid-square"
                    data-state={state}
                    aria-label={`${one.number} ${plain(GRID_LABEL[state], mode)}`}
                    aria-current={questionIdx === index}
                    onClick={() => jump(questionIdx)}
                    className={`size-11 rounded-[10px] border text-sm font-medium tabular-nums ${SQUARE_STATE[state]}`}
                  >
                    {one.number}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* The legend, so the three colours are never the only clue. */}
          <ul className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            {(['answered', 'marked', 'unseen'] as GridState[]).map((state) => (
              <li key={state} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`block size-4 rounded-[4px] border ${SQUARE_STATE[state]}`}
                />
                {plain(GRID_LABEL[state], mode)}
              </li>
            ))}
          </ul>

          <button type="button" onClick={() => setGridOpen(false)} className={QUIET}>
            {plain('exam.gridClose', mode)}
          </button>
        </div>
      ) : null}

      <div className={`${CARD} flex flex-col gap-3`}>
        <p className="text-[17px] leading-[26px] font-medium">{question.stem}</p>

        <ul className="flex flex-col gap-2">
          {question.options.map((text, optionIdx) => {
            const state = optionState(optionIdx);
            return (
              <li key={optionIdx}>
                <button
                  type="button"
                  data-testid="exam-option"
                  data-state={state}
                  aria-pressed={chosen === optionIdx}
                  disabled={submitted}
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

        {/* F-E5, said out loud. A student who sees no tick must know why. */}
        {!submitted ? (
          <p className="text-sm text-muted-foreground">{plain('exam.hidden', mode)}</p>
        ) : null}

        {/* The review, which exists only once the key has arrived. */}
        {submitted && reviewed ? (
          <details
            data-testid="exam-review"
            aria-live="polite"
            className="rounded-[10px] border border-border p-3"
          >
            <summary className="min-h-12 cursor-pointer list-none text-base font-medium">
              {plain('player.explanation', mode)}
            </summary>
            <p className="pt-2 text-base text-muted-foreground">
              {reviewed.teacherExplanation ?? plain('player.noExplanation', mode)}
            </p>
          </details>
        ) : null}
      </div>

      {failed ? (
        <p role="status" className={`${CARD} border-wrong text-sm text-wrong`}>
          {plain('exam.submitFailed', mode)}
        </p>
      ) : null}

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

        {!submitted ? (
          <button
            type="button"
            data-testid="exam-mark"
            aria-pressed={marked}
            onClick={toggleMark}
            className={`${marked ? `${OUTLINE} border-marked text-marked` : OUTLINE} order-3`}
          >
            {plain('player.mark', mode)}
          </button>
        ) : null}

        {!last ? (
          <button type="button" onClick={() => go(1)} className={`${PRIMARY} order-2`}>
            {plain('player.next', mode)}
          </button>
        ) : null}

        {submitted ? (
          // The result page above carries the same mark and a great deal more,
          // so this line is what shows UNTIL it arrives, and the whole of what
          // shows if the read never answers. Never both at once.
          result ? null : (
            <p
              data-testid="exam-score"
              role="status"
              className="order-5 col-span-2 text-center text-base font-bold tabular-nums"
            >
              {plain('player.score', mode)} {finalScore ?? 0} / {totalMarks(total, marking)}
            </p>
          )
        ) : (
          // Submit is reachable from EVERY question, not just the last one: a
          // clock means a student may want to stop before the end.
          <button
            type="button"
            data-testid="exam-submit"
            onClick={() => void submit()}
            disabled={submitting}
            className={last ? `${PRIMARY} order-4 col-span-2` : `${OUTLINE} order-4`}
          >
            {plain(submitting ? 'exam.submitting' : 'exam.submit', mode)}
          </button>
        )}
      </div>
    </div>
  );
}
