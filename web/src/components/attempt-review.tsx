/**
 * The review of one finished sitting (ticket 57-review-and-retake).
 *
 * WHAT WAS BROKEN. "Review" on a test the student had already finished opened
 * a blank NEW sitting, and in exam mode it could start a new timed one. Every
 * tap also left another `attempts` row behind. That is walk persona-1 gap 5
 * and persona-3 step 16: the student asked to see the paper again and the app
 * took the paper away instead.
 *
 * This is the screen that replaces it: every question of the sitting, in paper
 * order, with the whole stem, all four options, the one they picked, the right
 * one and the teacher's prose. `readAttemptReview()` (ticket 57a) read it all
 * on the server, and this file does no arithmetic of its own.
 *
 * READ ONLY, BY CONSTRUCTION, which is the whole ticket:
 *
 *  * A PAGE VIEW MUST NOT WRITE DATA. This component holds no client, no
 *    answer queue and no `fetch`, and it draws no option button, no radio and
 *    no form. There is nothing here that could post an answer even by
 *    accident, and its own test asserts the count of buttons and inputs is 0.
 *  * RETAKE IS A SEPARATE LINK, and the only thing on the panel that starts a
 *    new sitting. It says "Retake" in the student's own language, so the one
 *    tap that costs a fresh attempt row is the one tap that is labelled.
 *  * THE SCORE IS THE STORED ONE (0031). `review.score` is what
 *    `score_attempt()` wrote; counting the right answers again in the browser
 *    would disagree with it the moment a bad question is moderated.
 *  * 0030 AND 0037 ARE STATES, NOT GAPS. `right: null` is `question_keys()`
 *    refusing while this student has the same test open under a clock (F-E5),
 *    and `explanation: null` is either no prose at all or `question_explanations()`
 *    refusing for the same reason. The question is still listed, and the panel
 *    says which it is rather than drawing a letter nobody sent. Null with the
 *    key locked reads as locked prose; null with the key open reads as prose
 *    that was never written.
 *
 * COLOUR NEVER WORKS ALONE (DESIGN.md section 3). Every state carries an icon
 * AND its word: "Your answer", "Right answer", "Correct", "Wrong", "You
 * skipped this question".
 */
import Link from 'next/link';
import { Check, Clock, Eye, Flag, Lock, Minus, X } from 'lucide-react';
import type { AttemptReview, ResultOption, ReviewQuestion } from '@/lib/attempts/types';
import { timerLabel } from '@/lib/exam/types';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';

/** A card shell. Thin border, no shadow (DESIGN.md section 0). */
const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** One option row. Never a raw hex: the state is a token (DESIGN.md section 3). */
const OPTION_TONE = {
  right: 'border-correct-icon bg-correct-soft text-correct',
  wrong: 'border-wrong bg-wrong-soft text-wrong',
  plain: 'border-border text-foreground',
} as const;

type OptionTone = keyof typeof OPTION_TONE;

/**
 * The tone of one option row.
 *
 * The right one is green WHETHER OR NOT it was picked, because the point of a
 * review is to see it. The picked one is red only when it is not the right
 * one, so a correct answer is never drawn in two colours at once.
 */
function toneOf(one: ReviewQuestion, option: ResultOption): OptionTone {
  if (one.right?.idx === option.idx) return 'right';
  if (one.chosen?.idx === option.idx) return 'wrong';
  return 'plain';
}

/** One line of the summary: a word and a number, with its icon. */
function Tile({
  testId,
  Icon,
  label,
  value,
  tone,
}: {
  testId: string;
  Icon: typeof Check;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div data-testid={testId} className={`${CARD} flex flex-col gap-1`}>
      <span className={`flex items-center gap-1 text-xs leading-4 ${tone}`}>
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </span>
      <span className="text-xl leading-7 font-bold tabular-nums">{value}</span>
    </div>
  );
}

/** One question of the sitting: the stem, every option, the answer, the prose. */
function QuestionCard({ one, mode }: { one: ReviewQuestion; mode: LangMode }) {
  return (
    <li
      data-testid="attempt-review-question"
      className={`${CARD} flex flex-col gap-2`}
    >
      <p className="text-[17px] leading-[26px] font-medium">
        <span className="tabular-nums">{one.number}.</span> {one.stem}
      </p>

      {/* A LIST, not buttons: there is nothing to tap on a finished sitting. */}
      <ul className="flex flex-col gap-2">
        {one.options.map((option) => {
          const tone = toneOf(one, option);
          return (
            <li
              key={option.idx}
              data-testid="attempt-review-option"
              data-tone={tone}
              className={`flex items-start gap-2 rounded-[10px] border px-3 py-2 text-base leading-6 ${OPTION_TONE[tone]}`}
            >
              <span className="font-bold">{option.letter}.</span>
              <span>{option.text}</span>
            </li>
          );
        })}
      </ul>

      {one.chosen ? (
        <p
          data-testid="attempt-review-chosen"
          className={`flex items-start gap-2 text-sm leading-5 ${
            one.isCorrect === true ? 'text-correct' : 'text-wrong'
          }`}
        >
          {one.isCorrect === true ? (
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          ) : (
            <X aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          )}
          <span>
            <span className="font-medium">{plain('player.yourOption', mode)}:</span>{' '}
            <span className="font-bold">{one.chosen.letter}.</span> {one.chosen.text}
          </span>
        </p>
      ) : (
        /* Skipped is not wrong. The panel says so and claims no answer. */
        <p
          data-testid="attempt-review-skipped"
          className="flex items-start gap-2 text-sm leading-5 text-muted-foreground"
        >
          <Minus aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{plain('recap.skippedOne', mode)}</span>
        </p>
      )}

      {one.right === null ? (
        /* 0030 and F-E5: the key is shut while this student has the same test
           open under a clock. Say that, rather than draw a letter nobody sent. */
        <p
          data-testid="attempt-review-locked"
          className="flex items-start gap-2 text-sm leading-5 text-muted-foreground"
        >
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{plain('result.rightLocked', mode)}</span>
        </p>
      ) : one.isCorrect === true ? (
        /* The right answer IS the option above, already green and already
           named "Your answer". Saying it twice would only add noise. */
        null
      ) : (
        <p
          data-testid="attempt-review-right"
          className="flex items-start gap-2 text-sm leading-5 text-correct"
        >
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{plain('player.rightOption', mode)}:</span>{' '}
            <span className="font-bold">{one.right.letter}.</span> {one.right.text}
          </span>
        </p>
      )}

      {one.marked ? (
        <p
          data-testid="attempt-review-marked"
          className="flex items-start gap-2 text-sm leading-5 text-marked"
        >
          <Flag aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{plain('recap.marked', mode)}</span>
        </p>
      ) : null}

      {one.explanation !== null ? (
        <div data-testid="attempt-review-explanation" className="flex flex-col gap-1">
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {plain('player.explanation', mode)}
          </p>
          <p className="text-sm leading-5 whitespace-pre-line">{one.explanation}</p>
        </div>
      ) : one.right === null ? (
        /* 0037 is the twin of 0030 and shuts for the same reason, so a null
           prose beside a locked key is LOCKED prose, not missing prose. */
        <p
          data-testid="attempt-review-explanation-locked"
          className="flex items-start gap-2 text-sm leading-5 text-muted-foreground"
        >
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{plain('recap.explanationLocked', mode)}</span>
        </p>
      ) : (
        <p
          data-testid="attempt-review-no-explanation"
          className="text-sm leading-5 text-muted-foreground"
        >
          {plain('player.noExplanation', mode)}
        </p>
      )}
    </li>
  );
}

export function AttemptReviewPanel({
  review,
  mode = DEFAULT_MODE,
  outOf,
  retakeHref = null,
}: {
  /** Exactly what `readAttemptReview()` returned. Nothing is recomputed here. */
  review: AttemptReview;
  mode?: LangMode;
  /**
   * The marks the paper is out of (F-E6), which is `totalMarks(total, marking)`.
   * Left out for a past paper, and then the question total stands: one mark a
   * question, with no negative marking.
   */
  outOf?: number;
  /**
   * Where Retake goes: the START route, which is the ONLY place a new sitting
   * is created. Null draws no link, for a page that has nowhere to send them.
   */
  retakeHref?: string | null;
}) {
  const outOfMarks = outOf ?? review.total;

  return (
    <div data-testid="attempt-review" className="flex w-full flex-col gap-3 text-left">
      {/* The mark, as the result page showed it, so the two screens agree. */}
      <div
        data-testid="attempt-review-summary"
        className={`${CARD} flex flex-col items-center gap-1 py-5`}
      >
        <p className="text-sm leading-5 font-medium text-muted-foreground">
          {plain('result.title', mode)}
        </p>
        <p className="text-4xl leading-10 font-bold tabular-nums">
          {review.score} / {outOfMarks}
        </p>
        <p className="text-base leading-6 font-medium tabular-nums text-muted-foreground">
          {review.percent}%
        </p>
      </div>

      {/* Said in words, because the student tapped a button that used to start
          a new sitting and has every reason to expect this one did too. */}
      <p
        data-testid="attempt-review-readonly"
        className="flex items-start gap-2 text-sm leading-5 text-muted-foreground"
      >
        <Eye aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{plain('recap.readOnly', mode)}</span>
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          testId="attempt-review-right-count"
          Icon={Check}
          label={plain('result.right', mode)}
          value={String(review.right)}
          tone="text-correct"
        />
        <Tile
          testId="attempt-review-wrong-count"
          Icon={X}
          label={plain('result.wrong', mode)}
          value={String(review.wrong)}
          tone="text-wrong"
        />
        <Tile
          testId="attempt-review-skipped-count"
          Icon={Minus}
          label={plain('result.skipped', mode)}
          value={String(review.skipped)}
          tone="text-muted-foreground"
        />
        <Tile
          testId="attempt-review-time"
          Icon={Clock}
          label={plain('result.timeTaken', mode)}
          // The only arithmetic on this screen: seconds into a clock. The same
          // helper the exam timer uses, so the two read alike.
          value={timerLabel(review.timeTakenSec * 1000)}
          tone="text-muted-foreground"
        />
      </div>

      <h2 className="text-sm leading-5 font-medium text-muted-foreground">
        {plain('recap.questions', mode)}
      </h2>

      <ol className="flex flex-col gap-3">
        {review.questions.map((one) => (
          <QuestionCard key={one.questionId} one={one} mode={mode} />
        ))}
      </ol>

      {retakeHref ? (
        <Link
          data-testid="attempt-review-retake"
          href={retakeHref}
          // B3: a review page must not warm a route the student may never open,
          // and this one STARTS A SITTING, so warming it would be worse than
          // slow. It is only ever opened by a tap.
          prefetch={false}
          className="inline-flex min-h-12 items-center justify-center rounded-[10px] bg-primary px-5 text-base font-medium text-primary-foreground transition-colors duration-100"
        >
          <span className="flex flex-col items-center">
            {labels('recap.retake', mode).map((line, index) => (
              <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
                {line}
              </span>
            ))}
          </span>
        </Link>
      ) : null}
    </div>
  );
}
