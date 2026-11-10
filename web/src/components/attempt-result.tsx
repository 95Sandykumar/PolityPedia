/**
 * The result page of one submitted sitting (issue 56-result-page).
 *
 * Until this slice, finishing a paper ended on one line: "Score 12 / 20". The
 * payoff moment of the whole journey was a footnote, which is walk persona-1
 * gap 4, persona-2 gap 7 and persona-3 gap 6, all three saying the same thing:
 * the student learns nothing from the end of a test.
 *
 * This is the screen, and ONLY the screen. Every number on it was worked out
 * by `readAttemptResult()` (ticket 56a) on the server, and this file does no
 * arithmetic of its own beyond turning seconds into a clock. That is not
 * tidiness, it is rule 0031:
 *
 *  * THE SCORE IS THE STORED ONE. `result.score` is the number
 *    `score_attempt()` wrote with the exam's own marking scheme. A browser
 *    that counted the right answers again would disagree with it the moment a
 *    bad question is moderated, and the student would have seen two different
 *    marks for one paper. So nothing here counts anything.
 *  * `outOf` IS THE MARKS, NOT THE QUESTIONS (F-E6). CUET PG at +4 a question
 *    makes a 20-question paper worth 80, and the player passes
 *    `totalMarks(total, marking)` so the fraction reads the way the student
 *    expects. With no marking it falls back to the question total, which is
 *    one mark a question: exactly what a past paper is out of.
 *  * A NULL RIGHT ANSWER IS A STATE, NOT A GAP (0030). `question_keys()`
 *    refuses the key while the same student has an open exam sitting of the
 *    same test (F-E5), so `right` comes back null and this screen says the
 *    right answer is not open yet. It does not guess a letter.
 *
 * WHAT IS ON SCREEN. The mark and the percent big at the top, then four
 * tiles: right, wrong, skipped, time taken. Then the wrong questions, one
 * card each, with the short stem, the option the student chose and the right
 * one. Then the note that the wrong ones went to Saved, and a Next test link.
 *
 * COLOUR NEVER WORKS ALONE (DESIGN.md section 3). Every tile carries an icon
 * AND its word, every wrong card names "Your answer" and "Right answer" in
 * words, and the panel is the `role="status"` element of its screen so a
 * screen reader hears the result rather than only seeing it.
 *
 * An auto-submit at the deadline is NOT a different screen. It is this one
 * plus a line saying the clock closed the paper, which is the honest reading
 * of a sitting with ten skipped questions in it.
 */
import Link from 'next/link';
import { Check, Clock, ListChecks, Lock, Minus, Timer, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AttemptResult, ResultWrongQuestion } from '@/lib/attempts/types';
import { timerLabel } from '@/lib/exam/types';
import { DEFAULT_MODE, plain, type LangMode } from '@/lib/i18n';

/** A card shell. Thin border, no shadow (DESIGN.md section 0). */
const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** The three result tones, as tokens. Never a raw hex (DESIGN.md section 3). */
const TONE = {
  right: 'text-correct',
  wrong: 'text-wrong',
  quiet: 'text-muted-foreground',
} as const;

type Tone = keyof typeof TONE;

/**
 * One number of the breakdown: an icon, a word, a number.
 *
 * `tabular-nums` so four tiles side by side do not jiggle as the digits
 * change, and the word is never dropped on a narrow screen: it is the part a
 * colour-blind student reads.
 */
function Stat({
  testId,
  Icon,
  label,
  value,
  tone,
}: {
  testId: string;
  Icon: LucideIcon;
  label: string;
  value: string;
  tone: Tone;
}) {
  return (
    <div data-testid={testId} className={`${CARD} flex flex-col gap-1`}>
      <span className={`flex items-center gap-1 text-xs leading-4 ${TONE[tone]}`}>
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </span>
      <span className="text-xl leading-7 font-bold tabular-nums">{value}</span>
    </div>
  );
}

/** One question that went wrong: the stem, the answer given, the right one. */
function WrongRow({ one, mode }: { one: ResultWrongQuestion; mode: LangMode }) {
  return (
    <li data-testid="attempt-result-wrong-row" className={`${CARD} flex flex-col gap-2`}>
      <p className="text-sm leading-5">
        <span className="font-bold tabular-nums">{one.number}.</span>{' '}
        <span className="text-foreground">{one.stem}</span>
      </p>

      <p className="flex items-start gap-2 text-sm leading-5 text-wrong">
        <X aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-medium">{plain('player.yourOption', mode)}:</span>{' '}
          <span className="font-bold">{one.chosen.letter}.</span> {one.chosen.text}
        </span>
      </p>

      {one.right ? (
        <p className="flex items-start gap-2 text-sm leading-5 text-correct">
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{plain('player.rightOption', mode)}:</span>{' '}
            <span className="font-bold">{one.right.letter}.</span> {one.right.text}
          </span>
        </p>
      ) : (
        /* 0030 and F-E5: the key is shut while this student has the same test
           open under a clock. Say that, rather than draw a letter nobody sent. */
        <p
          data-testid="attempt-result-locked"
          className="flex items-start gap-2 text-sm leading-5 text-muted-foreground"
        >
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{plain('result.rightLocked', mode)}</span>
        </p>
      )}
    </li>
  );
}

export function AttemptResultPanel({
  result,
  mode = DEFAULT_MODE,
  outOf,
  nextHref = null,
}: {
  /** Exactly what `readAttemptResult()` returned. Nothing is recomputed here. */
  result: AttemptResult;
  mode?: LangMode;
  /**
   * The marks the paper is out of (F-E6), which is `totalMarks(total, marking)`.
   * Left out for a past paper, and then the question total stands: one mark a
   * question, with no negative marking.
   */
  outOf?: number;
  /** Where "Next test" goes. Null when the page above has nowhere to send them. */
  nextHref?: string | null;
}) {
  const outOfMarks = outOf ?? result.total;

  return (
    <div
      data-testid="attempt-result"
      role="status"
      className="flex w-full flex-col gap-3 text-left"
    >
      {/* The mark, big. One clear thing per screen (DESIGN.md section 0). */}
      <div className={`${CARD} flex flex-col items-center gap-1 py-5`}>
        <p className="text-sm leading-5 font-medium text-muted-foreground">
          {plain('result.title', mode)}
        </p>
        <p
          data-testid="attempt-result-score"
          className="text-4xl leading-10 font-bold tabular-nums"
        >
          {result.score} / {outOfMarks}
        </p>
        <p
          data-testid="attempt-result-percent"
          className="text-base leading-6 font-medium tabular-nums text-muted-foreground"
        >
          {result.percent}%
        </p>
      </div>

      {/* The clock closed it, not the student. A fact, not a failure. */}
      {result.autoSubmitted ? (
        <p
          data-testid="attempt-result-auto"
          className={`${CARD} flex items-center gap-2 border-marked text-sm leading-5 text-marked`}
        >
          <Timer aria-hidden="true" className="size-5 shrink-0" />
          <span>{plain('result.autoSubmitted', mode)}</span>
        </p>
      ) : null}

      {/* right + wrong + skipped is the question total, always: the reader
          walks the QUESTIONS, so a question nobody opened is a skip. */}
      <div data-testid="attempt-result-stats" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          testId="attempt-result-right"
          Icon={Check}
          label={plain('result.right', mode)}
          value={String(result.right)}
          tone="right"
        />
        <Stat
          testId="attempt-result-wrong"
          Icon={X}
          label={plain('result.wrong', mode)}
          value={String(result.wrong)}
          tone="wrong"
        />
        <Stat
          testId="attempt-result-skipped"
          Icon={Minus}
          label={plain('result.skipped', mode)}
          value={String(result.skipped)}
          tone="quiet"
        />
        <Stat
          testId="attempt-result-time"
          Icon={Clock}
          label={plain('result.timeTaken', mode)}
          // The only arithmetic on this screen: seconds into a clock. The same
          // helper the exam timer uses, so the two read alike.
          value={timerLabel(result.timeTakenSec * 1000)}
          tone="quiet"
        />
      </div>

      {/* The wrong questions. A LIST, one line of stem each: the whole stem and
          the explanation are the review screen's job (ticket 57). */}
      {result.wrongQuestions.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm leading-5 font-medium text-muted-foreground">
            {plain('result.wrongTitle', mode)}
          </h2>
          <ul className="flex flex-col gap-2">
            {result.wrongQuestions.map((one) => (
              <WrongRow key={one.questionId} one={one} mode={mode} />
            ))}
          </ul>
        </section>
      ) : null}

      {result.wrong === 0 ? (
        <p
          data-testid="attempt-result-none-wrong"
          className={`${CARD} flex items-center gap-2 border-correct-icon text-sm leading-5 text-correct`}
        >
          <ListChecks aria-hidden="true" className="size-5 shrink-0" />
          <span>{plain('result.noneWrong', mode)}</span>
        </p>
      ) : (
        /* F-E8: a wrong answer saved itself while the student was answering, so
           this line reports what already happened. It does not write anything. */
        <p
          data-testid="attempt-result-saved"
          className="text-sm leading-5 text-muted-foreground"
        >
          {/* One wrong answer gets its own sentence, never "1 wrong answers"
              (ticket 56b). Global replace, because `both` mode joins the
              English and the Hindi line and {n} is in each of them. */}
          {plain(result.wrong === 1 ? 'result.savedOne' : 'result.saved', mode).replace(
            /\{n\}/g,
            String(result.wrong),
          )}
        </p>
      )}

      {nextHref ? (
        <Link
          data-testid="attempt-result-next"
          href={nextHref}
          // B3: a result page must not warm a route the student may never open.
          prefetch={false}
          className="inline-flex min-h-12 items-center justify-center rounded-[10px] bg-primary px-5 text-base font-medium text-primary-foreground transition-colors duration-100"
        >
          {plain('result.next', mode)}
        </Link>
      ) : null}
    </div>
  );
}
