'use client';

/**
 * The student's Mock test list (issue 16-set-access-mock-list).
 *
 * DESIGN.md section 8, the whole rule in one paragraph: "Set header with price
 * or 'Unlocked'. Rows: test name, score 64/200 (tabular), tick when taken,
 * button Attempt or Review. Locked rows show a lock icon and one 'Unlock
 * Rs 399' button for the whole set. Above the list: Topic dropdown (Full paper
 * by default) and a 2-way switch Practice | Exam."
 *
 * A client component, because the topic, the mode and the checkout state are
 * all state. The rows themselves arrive already built by `buildMockRows()` on
 * the server, so no key and no access rule ships to the browser.
 *
 * WHAT THIS COMPONENT IS NOT. It is not the gate. `open` on a row only decides
 * which button is drawn; a student who taps Attempt on a locked test reaches a
 * player that reads ZERO questions, because the restrictive policy in
 * `0016_set_access.sql` is the gate. Never move that rule up here.
 *
 * UNLOCK TAKES MONEY (issue 26-razorpay-order-checkout). On tap it posts to
 * `/api/checkout/order`, which asks Postgres for the price and Razorpay for an
 * order, then opens the gateway modal. Two rules live in that one sentence:
 *
 *  * NO PRICE IS SENT. `set.priceInr` is drawn on the button and nowhere else.
 *    What is charged is what `start_set_purchase()` quotes (F-G2), so a student
 *    who edits this component's props changes the label and not the bill.
 *  * `checkout.js` IS LOADED ON TAP, inside `openRazorpayCheckout()`, never at
 *    import time. DESIGN.md section 10 caps a student page at 150 KB gzipped,
 *    and a student who never buys must not carry a gateway bundle.
 *
 * Confirming the payment is issue 27's webhook, not this file. That is also
 * why a free unlock asks for a reload instead of flipping the rows open by
 * itself: the server is the only thing allowed to say a set is unlocked.
 */
import { BookOpenCheck, Check, ChevronRight, ListChecks, Lock, LockOpen, Timer } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { ReadError } from '@/components/read-error';
import { CARD, EmptyState, Lines } from '@/components/student-ui';
import { ATTEMPT_MODES, type AttemptMode } from '@/lib/attempts/types';
import {
  createBrowserCheckoutClient,
  openRazorpayCheckout as openRazorpayCheckoutDefault,
} from '@/lib/purchases/browser-checkout-client';
import {
  MAX_COUPON_LENGTH,
  normaliseCoupon,
  type BrowserCheckoutClient,
} from '@/lib/purchases/types';
import {
  MOCK_TOPIC_ALL,
  isTaken,
  mockPlayerPath,
  priceLabels,
  unlockLabels,
  type MockSetRow,
  type MockTopic,
} from '@/lib/set-access/types';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';

/** 48 px tall, the touch-target floor (DESIGN.md section 5). */
const ACTION =
  'inline-flex min-h-12 min-w-24 shrink-0 items-center justify-center gap-1 rounded-[10px] border border-primary bg-card px-3 text-base font-medium text-primary transition-colors duration-100';
const ACTION_PRIMARY =
  'inline-flex min-h-12 min-w-24 shrink-0 items-center justify-center gap-1 rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100';
const UNLOCK =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100';
const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const SWITCH_ON =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-[8px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100';
const SWITCH_OFF =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-[8px] px-3 text-base font-medium text-foreground transition-colors duration-100';
const BADGE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm leading-5 font-medium';

/**
 * What a refusal from our own route says on screen. Every code the route can
 * answer with gets a sentence of its own, because "already unlocked" and "that
 * coupon is wrong" ask the student to do different things. An unknown code
 * falls back to "try again": a code we do not recognise is not a code we can
 * explain.
 */
const CHECKOUT_MESSAGE: Record<string, MessageKey> = {
  coupon: 'checkout.badCoupon',
  owned: 'checkout.owned',
  // The student tapped Unlock twice while Razorpay was still confirming
  // (issue 61-block-second-order). The server refused the second order, so
  // the honest thing to say is that their payment is already running.
  pending: 'checkout.pending',
  sign_in: 'checkout.signIn',
  not_configured: 'checkout.notConfigured',
};

/** One client for the whole page, built on first use and never at import. */
let sharedCheckout: BrowserCheckoutClient | null = null;
function defaultCheckout(): BrowserCheckoutClient {
  sharedCheckout ??= createBrowserCheckoutClient();
  return sharedCheckout;
}

/** What Unlock is doing, for the one set whose button was tapped. */
type UnlockState =
  | { setId: string; kind: 'working' }
  | { setId: string; kind: 'free' }
  | { setId: string; kind: 'error'; message: MessageKey };

export function MockList({
  sets,
  teacherId,
  topics = [],
  mode = DEFAULT_MODE,
  failed = false,
  checkout,
  openCheckout = openRazorpayCheckoutDefault,
}: {
  sets: readonly MockSetRow[];
  /**
   * True when the server read FAILED rather than came back empty
   * (issue 54a-read-error-core). It wins over `sets`: a failure with rows in
   * hand means part of the read chain answered and part did not, so the locks,
   * ticks and scores could be wrong, and a wrong lock is a set sold twice or a
   * paid set still shut. The screen says so and offers Retry instead.
   */
  failed?: boolean;
  /** Whose portfolio this is, so the player link knows where it came from. */
  teacherId: string;
  /**
   * The topic dropdown's options. EMPTY in v1: there is no topic catalogue
   * yet, so the dropdown offers Full paper on its own (design.md: "`topics`:
   * reuse v0 `taxonomy`"). The choice still travels into the player link, so
   * issue 17-practice-mode only has to read it.
   */
  topics?: readonly MockTopic[];
  mode?: LangMode;
  /** Injected in tests, so no request to our route is ever real. */
  checkout?: BrowserCheckoutClient;
  /** Injected in tests. The default is what loads `checkout.js` on tap. */
  openCheckout?: typeof openRazorpayCheckoutDefault;
}) {
  const [topicId, setTopicId] = useState<string>(MOCK_TOPIC_ALL);
  const [attemptMode, setAttemptMode] = useState<AttemptMode>('practice');
  /** The coupon box per set. Empty is the normal case, not a mistake. */
  const [coupons, setCoupons] = useState<Record<string, string>>({});
  /** The set whose Unlock button was tapped, so the message sits next to it. */
  const [unlocking, setUnlocking] = useState<UnlockState | null>(null);
  /**
   * A ref and not the state above, because two taps inside one tick both read
   * the OLD state and would both order. A double order is a double charge.
   */
  const inFlight = useRef(false);

  async function unlock(set: MockSetRow) {
    if (inFlight.current) return;
    inFlight.current = true;
    setUnlocking({ setId: set.id, kind: 'working' });

    try {
      const start = await (checkout ?? defaultCheckout()).start({
        setId: set.id,
        // Trimmed and upper-cased by the same function the server uses, so a
        // student who typed " free100 " is not told their coupon is wrong.
        coupon: normaliseCoupon(coupons[set.id]),
      });

      if (start.free) {
        // A4. The server has already written `purchases` paid and
        // `set_access`, so the set IS open and the rows on screen are now
        // stale. Asking for a reload is honest and keeps the gate server-side.
        setUnlocking({ setId: set.id, kind: 'free' });
        return;
      }

      await openCheckout({ order: start, description: set.title });
      // The modal is up. Whatever happens inside it, issue 27's webhook is
      // what grants the set, so there is nothing left for this file to say.
      setUnlocking(null);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const message = typeof code === 'string' ? CHECKOUT_MESSAGE[code] : undefined;
      setUnlocking({ setId: set.id, kind: 'error', message: message ?? 'checkout.failed' });
    } finally {
      inFlight.current = false;
    }
  }

  // Checked BEFORE the empty state, never after: the whole point of the
  // ticket is that a broken read must not say "No mock tests yet".
  if (failed) {
    return <ReadError mode={mode} />;
  }

  if (sets.length === 0) {
    return (
      <EmptyState Icon={ListChecks} text={plain('mockList.none', mode)} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Above the list, in DESIGN.md's order: topic, then mode. */}
      <div className={`${CARD} flex flex-col gap-3 p-4`}>
        <label htmlFor="mock-topic" className="text-sm leading-5 font-medium">
          <Lines keyName="mockList.topic" mode={mode} />
        </label>
        <select
          id="mock-topic"
          name="topic"
          value={topicId}
          onChange={(event) => setTopicId(event.target.value)}
          className={FIELD}
        >
          <option value={MOCK_TOPIC_ALL}>{plain('mockList.topicAll', mode)}</option>
          {topics.map((topic) => (
            <option key={topic.id} value={topic.id}>
              {topic.name}
            </option>
          ))}
        </select>

        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-sm leading-5 font-medium">{plain('mockList.mode', mode)}</legend>
          {/* A 2-way segmented switch: one track, two 48 px halves. */}
          <div className="flex gap-1 rounded-[10px] border border-border bg-background p-1">
            {ATTEMPT_MODES.map((one) => (
              <button
                key={one}
                type="button"
                // A 2-way switch, so the pressed state is spoken, not only
                // coloured (DESIGN.md section 11).
                aria-pressed={attemptMode === one}
                onClick={() => setAttemptMode(one)}
                className={attemptMode === one ? SWITCH_ON : SWITCH_OFF}
              >
                {one === 'exam' ? (
                  <Timer aria-hidden="true" className="size-5" strokeWidth={2} />
                ) : (
                  <BookOpenCheck aria-hidden="true" className="size-5" strokeWidth={2} />
                )}
                {plain(one === 'exam' ? 'mockList.exam' : 'mockList.practice', mode)}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {sets.map((set) => {
        const taken = set.tests.filter((test) => isTaken(test)).length;
        const total = set.tests.length;
        return (
          <section key={set.id} className={`${CARD} flex flex-col gap-3 p-4`}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 text-[18px] leading-7 font-bold">{set.title}</h2>
              {/* Price or "Unlocked", never both. Prices are tabular. */}
              <span
                className={`${BADGE} shrink-0 tabular-nums ${
                  set.unlocked
                    ? 'border-correct-icon bg-correct-soft text-correct'
                    : 'border-primary bg-primary/10 text-primary'
                }`}
              >
                {set.unlocked ? <LockOpen aria-hidden="true" className="size-4" /> : null}
                {priceLabels(set, mode).join(' / ')}
              </span>
            </div>

            {total > 0 ? (
              <div className="flex items-center gap-3">
                <div
                  aria-hidden="true"
                  className="h-2 grow overflow-hidden rounded-full bg-border"
                >
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${(taken / total) * 100}%` }}
                  />
                </div>
                <p className="shrink-0 text-sm leading-5 font-medium tabular-nums text-muted-foreground">
                  {taken}/{total} {plain('sui.takenOf', mode)}
                </p>
              </div>
            ) : null}

            {set.tests.length === 0 ? (
              <p role="status" className="text-muted-foreground">
                {plain('mockList.noTests', mode)}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {set.tests.map((test, rowIndex) => (
                  <li
                    key={test.id}
                    className="flex items-center gap-3 rounded-[10px] border border-border bg-background p-3"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-card text-sm font-bold tabular-nums text-muted-foreground ring-1 ring-border"
                    >
                      {rowIndex + 1}
                    </span>

                    <div className="flex min-w-0 grow flex-col gap-1">
                      <span className="text-base leading-6 font-medium">{test.title}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        {/* Locked: the lock is not colour alone, it has a name a
                            screen reader reads out. */}
                        {test.open ? null : (
                          <>
                            <Lock
                              aria-label={plain('mockList.locked', mode)}
                              role="img"
                              className="size-5 text-muted-foreground"
                            />
                            <span aria-hidden="true" className="text-sm leading-5 text-muted-foreground">
                              {plain('mockList.locked', mode)}
                            </span>
                          </>
                        )}
                        {test.isFreeSample ? (
                          <span className={`${BADGE} border-primary text-primary`}>
                            {plain('mocks.freeSample', mode)}
                          </span>
                        ) : null}
                        {isTaken(test) ? (
                          <>
                            <Check
                              aria-label={plain('mockList.taken', mode)}
                              role="img"
                              className="size-5 text-correct"
                            />
                            <span
                              aria-label={`${plain('mockList.score', mode)}: ${test.score}`}
                              className="inline-flex items-baseline gap-1 text-sm leading-5 text-muted-foreground"
                            >
                              <span aria-hidden="true">{plain('mockList.score', mode)}</span>
                              <span className="text-base leading-6 font-bold tabular-nums text-foreground">
                                {test.score}
                              </span>
                            </span>
                          </>
                        ) : null}
                      </span>
                    </div>

                    {/* An open test gets exactly one button: Review once it has
                        been taken, Attempt before that. A locked test gets none:
                        the set has ONE Unlock button, under the list. */}
                    {test.open ? (
                      <Link
                        href={mockPlayerPath(teacherId, test.id, {
                          mode: attemptMode,
                          topicId,
                        })}
                        prefetch={false}
                        aria-label={`${test.title}: ${plain(
                          isTaken(test) ? 'mockList.review' : 'mockList.attempt',
                          mode,
                        )}`}
                        className={isTaken(test) ? ACTION : ACTION_PRIMARY}
                      >
                        <span className="flex flex-col items-center">
                          <Lines
                            keyName={isTaken(test) ? 'mockList.review' : 'mockList.attempt'}
                            mode={mode}
                          />
                        </span>
                        <ChevronRight aria-hidden="true" className="size-4" strokeWidth={2.5} />
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {/* One button for the whole set, not one per row (DESIGN.md). */}
            {set.unlocked ? null : (
              <div className="flex flex-col gap-3 rounded-[10px] border border-primary/30 bg-primary/5 p-3">
                <p className="flex items-start gap-2 text-sm leading-5">
                  <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>{plain('sui.unlockHint', mode)}</span>
                </p>
                <label htmlFor={`coupon-${set.id}`} className="text-sm leading-5 font-medium">
                  <Lines keyName="checkout.coupon" mode={mode} />
                </label>
                <input
                  id={`coupon-${set.id}`}
                  name="coupon"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_COUPON_LENGTH}
                  value={coupons[set.id] ?? ''}
                  onChange={(event) =>
                    setCoupons((was) => ({ ...was, [set.id]: event.target.value }))
                  }
                  aria-label={plain('checkout.coupon', mode)}
                  className={`${FIELD} uppercase`}
                />
                <button
                  type="button"
                  onClick={() => void unlock(set)}
                  // Disabled only while THIS set's order is being made, so the
                  // other sets on the page stay tappable.
                  disabled={unlocking?.setId === set.id && unlocking.kind === 'working'}
                  aria-label={unlockLabels(set.priceInr, mode).join(' / ')}
                  className={`${UNLOCK} tabular-nums disabled:opacity-60`}
                >
                  <span className="flex flex-col items-center">
                    {unlockLabels(set.priceInr, mode).map((line, index) => (
                      <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                        {line}
                      </span>
                    ))}
                  </span>
                </button>
                {unlocking?.setId === set.id ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className={
                      unlocking.kind === 'error'
                        ? 'text-sm text-wrong'
                        : 'text-sm text-muted-foreground'
                    }
                  >
                    {plain(
                      unlocking.kind === 'working'
                        ? 'checkout.opening'
                        : unlocking.kind === 'free'
                          ? 'checkout.unlockedFree'
                          : unlocking.message,
                      mode,
                    )}
                  </p>
                ) : null}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
