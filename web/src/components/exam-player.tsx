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
 *
 * WRITES GO THROUGH THE QUEUE (issue 58-exam-answer-queue), never straight to
 * `fetch`. An answer the network refused is kept on the phone and sent when
 * the net returns, the bar says so, the unsent answer carries a "saving" mark,
 * and SUBMIT FLUSHES THE QUEUE FIRST and refuses while anything is still held.
 * The old code fired one `fetch` per tap and swallowed the failure, which is
 * how a dropped signal turned into a lower score with no warning.
 */
import { Check, Clock, LayoutGrid, ListChecks, RefreshCw, WifiOff, X } from 'lucide-react';
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
import { createExamAnswerQueue } from '@/lib/exam/exam-answer-queue';
import {
  AUTO_SUBMIT_TRIES,
  RETRY_MS,
  gridState,
  remainingMs,
  timerLabel,
  timerTone,
  type BrowserExamClient,
  type ExamAnswerQueue,
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
  reviewHref = null,
  client,
  queue: given,
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
  /**
   * Where the result page's "Review mistakes" goes: the READ ONLY review
   * route of this test (ticket 57b). Null draws no link.
   */
  reviewHref?: string | null;
  /** Our own routes. Holds no key, and never marks anything itself. */
  client: BrowserExamClient;
  /**
   * The offline answer queue (issue 58-exam-answer-queue).
   *
   * OPTIONAL, and one over `client.saveAnswer` is built when it is left out,
   * so every caller gets the retries without wiring anything. A test passes
   * its own, over a Map instead of `localStorage`.
   */
  queue?: ExamAnswerQueue;
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
  /**
   * The net, as the browser sees it. STARTS OPTIMISTIC so the server-rendered
   * markup and the first client render agree; the effect below corrects it on
   * mount, the same as `question-player.tsx`.
   */
  const [online, setOnline] = useState(true);
  /** The question ids the server has not taken yet. Drives the saving mark. */
  const [heldIds, setHeldIds] = useState<readonly string[]>([]);
  /** How many answers Submit could not get through. 0 hides the message. */
  const [unsaved, setUnsaved] = useState(0);

  /**
   * The queue. Built here when the caller did not pass one, so there is no
   * path through this component that writes an answer straight to `fetch`.
   *
   * `useMemo` keyed by the sitting: a re-render must not build a second queue
   * mid-tap, and a second queue over the same `localStorage` key would be two
   * things sending one line.
   */
  const built = useMemo(
    () =>
      createExamAnswerQueue({
        attemptId,
        save: (answer) => client.saveAnswer(answer),
        // A wrong `false` would hold answers back for no reason, so an
        // unreadable `navigator` reads as online: a failed send costs one
        // request, a held answer costs the student marks.
        isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      }),
    [attemptId, client],
  );
  const queue = given ?? built;

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
  const submit = useCallback(async (): Promise<boolean> => {
    if (submitted) return true;
    if (sending.current) return false;
    sending.current = true;
    setSubmitting(true);
    setFailed(false);
    setUnsaved(0);
    try {
      /**
       * THE QUEUE GOES FIRST, and a paper with answers still held is NOT
       * closed. `score_attempt()` marks whatever rows exist at the moment it
       * runs, so submitting over a held answer would hand the student a score
       * for a paper they did not sit. Better a message they can act on.
       */
      const stillHeld = await queue.flush();
      if (stillHeld > 0) {
        setUnsaved(stillHeld);
        sending.current = false;
        return false;
      }

      const got = await client.submit(attemptId);
      setFinalScore(got);
      setSubmitted(true);
      // The key arrives HERE, after the sitting is closed, and only because
      // Postgres now has a `submitted_at`.
      const fresh = await client.load().catch(() => null);
      if (fresh?.revealed) setKeyed(fresh.questions as readonly Question[]);
      return true;
    } catch {
      // The paper is still on screen and the answers are stored, so the
      // student simply taps Submit again. The latch opens for that.
      sending.current = false;
      setFailed(true);
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, client, queue, submitted]);

  // The clock. One interval, and it stops itself once the paper is in.
  useEffect(() => {
    if (deadlineAt === null || submitted) return;

    setLeft(remainingMs(deadlineAt, now()));
    const tick = setInterval(() => {
      setLeft(remainingMs(deadlineAt, now()));
    }, 1000);
    return () => clearInterval(tick);
  }, [deadlineAt, now, submitted]);

  /**
   * Time up: submit by itself. Postgres has stopped taking answers at exactly
   * this moment, so leaving the paper open would be a screen that lies.
   *
   * IT RETRIES, every `RETRY_MS`, which is the bug this slice fixes: a phone
   * with no signal at 00:00 used to fail once and stop, and the sitting then
   * sat open with no score until the student noticed. B6 wants the retry
   * BOUNDED, so there is at most one request per 10 seconds and at most
   * `AUTO_SUBMIT_TRIES` of them, and every one of them flushes the answer
   * queue first.
   *
   * THE LATCH IS A REF so a re-render cannot start a second chain, and the
   * CLEANUP RELEASES IT so React's StrictMode remount in development re-arms
   * instead of going quiet (the same trick as the result read below).
   */
  const autoRunning = useRef(false);
  useEffect(() => {
    if (left !== 0 || submitted || autoRunning.current) return;
    autoRunning.current = true;

    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function attempt(): Promise<void> {
      if (!alive) return;
      tries += 1;
      const done = await submit();
      // Stop on success, on unmount, and at the bound. Never a loop.
      if (done || !alive || tries >= AUTO_SUBMIT_TRIES) return;
      timer = setTimeout(() => void attempt(), RETRY_MS);
    }

    void attempt();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      autoRunning.current = false;
    };
  }, [left, submit, submitted]);

  /**
   * The net, straight from the browser. We never poll.
   *
   * Coming back online FLUSHES, which is the whole reason for keeping a queue.
   */
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

  /**
   * Which answers are still held, so the bar can count them and the question
   * can carry a "saving" mark.
   *
   * READ IN AN EFFECT, never during render: the queue restores from
   * `localStorage` the moment it is built, and a first client render that knew
   * about two held answers would not match the server's markup.
   *
   * THE SAME EFFECT FLUSHES ON MOUNT, which is how a RELOAD finishes what the
   * closed tab started. On unmount the queue is stopped (B6), and what is
   * still held stays on the phone for the next page load.
   */
  useEffect(() => {
    setHeldIds(queue.waiting());
    const off = queue.subscribe(() => setHeldIds(queue.waiting()));
    void queue.flush();
    return () => {
      off();
      queue.stop();
    };
  }, [queue]);

  /**
   * While answers are held, try again on the 10 second schedule (B6).
   *
   * One request per tick at most, because the queue stops at the first failure
   * and serialises its sends, and the interval is cleared on unmount. It is
   * armed only while something is actually stuck, so a healthy sitting runs no
   * timer at all.
   */
  const heldCount = heldIds.length;
  useEffect(() => {
    if (submitted || heldCount === 0) return;
    const tick = setInterval(() => void queue.flush(), RETRY_MS);
    return () => clearInterval(tick);
  }, [heldCount, queue, submitted]);

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
      // The latch is a ref, so it SURVIVES a remount, and React's StrictMode
      // remounts every component once in development. Without this reset the
      // second mount of an already closed sitting reads the latch as "asked"
      // while the first mount's answer was thrown away by `alive`, and the
      // developer never sees the result page the student sees. The cost is
      // one extra read in development only (ticket 56b).
      askedResult.current = false;
    };
  }, [attemptId, readResult, submitted]);

  const store = useCallback(
    (questionId: string, next: AttemptAnswer) => {
      setAnswers((before) => {
        const after = new Map(before);
        after.set(questionId, next);
        return after;
      });
      // One upsert per change, keyed by attempt and question (A1), THROUGH THE
      // QUEUE. Never awaited: a dead network must not stop the paper, and the
      // answer is already on screen. Never caught either, because `push` does
      // not throw; a failed send is held, not lost.
      void queue.push({
        attemptId,
        questionId,
        chosenIdx: next.chosenIdx,
        marked: next.marked,
      });
      // A new answer is a new chance, so the old "could not save" count goes.
      setUnsaved(0);
    },
    [attemptId, queue],
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

  /** True while the server has not taken THIS question's answer yet. */
  const saving = !submitted && heldIds.includes(question.id);

  return (
    <div className="flex flex-col gap-3">
      {/* DESIGN.md section 9, with the one word that matters in a timed paper:
          WHERE the answers are. "Saved" on its own is what the old player
          implied while it was dropping them. */}
      {!online ? (
        <p
          data-testid="exam-offline"
          role="status"
          className={`${CARD} flex items-center gap-2 border-marked text-sm text-marked`}
        >
          <WifiOff aria-hidden="true" className="size-5 shrink-0" />
          <span className="grow">{plain('exam.offlineKept', mode)}</span>
          {heldCount > 0 ? (
            <span className="shrink-0 tabular-nums font-bold">{heldCount}</span>
          ) : null}
        </p>
      ) : null}

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
          reviewHref={reviewHref}
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

        {/* The saving mark. Icon AND word, so the amber never stands alone,
            and it is per QUESTION, because that is what the student can act
            on: this is the one the server has not got yet. */}
        {saving ? (
          <p
            data-testid="exam-saving"
            role="status"
            className="flex items-center gap-1 text-sm font-medium text-marked"
          >
            <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
            {plain('exam.saving', mode)}
          </p>
        ) : null}

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

      {/* Submit stopped because answers are still on the phone. It names the
          COUNT, so the student knows how much is at stake, and the paper is
          still open behind it. One wrong answer gets its own sentence, never
          "1 answers"; the replace is global because `both` mode joins the
          English and the Hindi line and {n} is in each of them. */}
      {unsaved > 0 ? (
        <p
          data-testid="exam-save-failed"
          role="status"
          className={`${CARD} border-wrong text-sm text-wrong`}
        >
          {plain(unsaved === 1 ? 'exam.saveFailedOne' : 'exam.saveFailed', mode).replace(
            /\{n\}/g,
            String(unsaved),
          )}
        </p>
      ) : null}

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
