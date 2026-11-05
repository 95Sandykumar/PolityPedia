/**
 * The nightly reconcile, as one function (issue 29-ledger-reconcile-payouts).
 *
 * design.md A6: "Nightly reconcile: Razorpay payments vs `purchases`,
 * mismatch -> alert."
 *
 * `web/jobs/ledger-reconcile.ts` is only wiring. Every rule is here, because
 * `npm test` must run the whole of A6 with no network and no key
 * (web/CLAUDE.md), and a file that reads `process.env` at the top cannot be
 * imported by a test.
 *
 * WHAT IT IS FOR. Both halves of a sale are already protected against
 * themselves: the webhook de-dupes on the event id and the ledger is UNIQUE
 * per purchase (0027). What neither of them can catch is a webhook that NEVER
 * ARRIVED. Razorpay retries and then gives up; a deploy mid-retry, an expired
 * secret or a 502 is enough. Nothing in the app notices, because the thing
 * that would have noticed is the request that went missing. This job is the
 * only place that compares the two sides from outside.
 *
 * WHY IT IS SAFE TO RUN TWICE, in one line: it never writes a decision, only
 * a question, and `(kind, subject)` is UNIQUE in Postgres, so the second
 * sighting of a problem writes nothing. No purchase is changed, no set is
 * opened and no money moves. A human reads the alerts and acts.
 *
 * AN ALERT IS A QUESTION, NOT A VERDICT. The two sides are read over a window,
 * and a window has edges: a sale paid seconds before the window opened can
 * show as `no_payment` once, and the 48-hour overlap plus the UNIQUE key mean
 * that costs one line on a list rather than a wrong refund. The job would
 * rather ask Boss twice than miss money.
 *
 * WHAT IT LOGS: counts only. Never a payment id, never an order id, never an
 * email, never a key. The ids are in the alert row, which only an admin can
 * read.
 */
import { isSubscriptionPayment, type PaymentRecord, type Payments } from '@/lib/purchases/types';
import { PAISE_PER_RUPEE } from '@/lib/purchases/types';
import {
  CAPTURED_STATUS,
  EXIT_CANNOT_CHECK,
  EXIT_CHECKED,
  orderSubject,
  reconcileWindow,
  RECONCILE_WINDOW_HOURS,
  unreadableSubject,
  type ReconcileAlertInput,
  type ReconcileOutcome,
  type ReconcilePurchase,
  type ReconcileStore,
} from './types';

export { EXIT_CANNOT_CHECK, EXIT_CHECKED };

export interface RunReconcileInput {
  payments: Payments;
  store: ReconcileStore;
  /** Injected so the window is the same in every test run. */
  now?: number;
  /** Overridable for a one-off catch-up run by hand. */
  windowHours?: number;
}

/** Rupees as the gateway counts them, so the two sides can be compared. */
function toPaise(amountInr: number): number {
  return Math.round(amountInr) * PAISE_PER_RUPEE;
}

/**
 * One captured payment against what we know, or null when it lines up.
 *
 * Order matters and each step is a different problem for a human:
 *  1. no row at all        -> a student paid for nothing
 *  2. a row that never paid -> the webhook was lost, the set is shut
 *  3. a row with the wrong amount -> both sides think they are done
 */
function checkPayment(
  payment: PaymentRecord,
  purchase: ReconcilePurchase | undefined,
): ReconcileAlertInput | null {
  const base = { subject: payment.paymentId, orderId: payment.orderId };

  if (!purchase) {
    // The worst case, and the reason this job reads the whole window rather
    // than asking about orders we already know: a payment with no purchase has
    // no order of ours to ask about.
    return { ...base, kind: 'no_purchase', expectedPaise: null, actualPaise: payment.amountPaise };
  }

  const expectedPaise = toPaise(purchase.amountInr);

  if (purchase.status !== 'paid') {
    return { ...base, kind: 'not_paid', expectedPaise, actualPaise: payment.amountPaise };
  }

  if (expectedPaise !== payment.amountPaise) {
    return { ...base, kind: 'amount_mismatch', expectedPaise, actualPaise: payment.amountPaise };
  }

  return null;
}

export async function runReconcile({
  payments,
  store,
  now = Date.now(),
  windowHours = RECONCILE_WINDOW_HOURS,
}: RunReconcileInput): Promise<ReconcileOutcome> {
  const idle: ReconcileOutcome = {
    type: 'idle',
    payments: 0,
    purchases: 0,
    alerts: 0,
    fresh: 0,
    unreadable: 0,
    subscriptions: 0,
  };

  // A missing key is NOT a quiet night. Reading one side and not the other
  // would make every sale look like a mismatch and bury Boss in alerts about
  // nothing, so neither side is read at all.
  if (!payments.isConfigured() || !store.isConfigured()) return idle;

  const window = reconcileWindow(now, windowHours);

  const listed = await payments.listPayments({
    fromSeconds: window.fromSeconds,
    toSeconds: window.toSeconds,
  });
  // THROWS on a failed read and on the row cap. `runReconcileJob` turns that
  // into a non-zero exit code, because a truncated list of our own sales
  // would file every sale the job did not see as `no_payment`.
  const page = await store.listPurchases({ sinceIso: window.sinceIso });
  const ours = page.purchases;

  // An order id is UNIQUE on `purchases` (A1, 0026), so this never collapses
  // two real rows into one.
  const byOrder = new Map<string, ReconcilePurchase>();
  for (const purchase of ours) {
    if (purchase.orderId) byOrder.set(purchase.orderId, purchase);
  }

  const found: ReconcileAlertInput[] = [];
  /** Orders the gateway captured, so our side knows what it has seen. */
  const capturedOrders = new Set<string>();
  /** Monthly plan charges, counted and then left alone. */
  let subscriptions = 0;

  for (const payment of listed) {
    // Only money that actually moved. An `authorized`, `failed` or `created`
    // payment is not a sale, and filing it as one would send Boss chasing a
    // student who was never charged.
    if (payment.status !== CAPTURED_STATUS) continue;

    // A MONTHLY PLAN CHARGE IS NOT A SET SALE (issue 35-reconcile-visible).
    // Razorpay bills a subscription against an order IT made, so that order id
    // can never be in `purchases` and every charge was filed as `no_purchase`:
    // one false alert per subscriber per month, which is exactly how the real
    // alerts become unfindable.
    //
    // `continue` BEFORE `capturedOrders`, on purpose. Adding it would mean a
    // subscription charge could vouch for one of our own orders and hide a
    // real `no_payment`, and a subscription charge knows nothing about our
    // set sales.
    if (isSubscriptionPayment(payment)) {
      subscriptions += 1;
      continue;
    }

    if (payment.orderId) capturedOrders.add(payment.orderId);

    const alert = checkPayment(
      payment,
      payment.orderId ? byOrder.get(payment.orderId) : undefined,
    );
    if (alert) found.push(alert);
  }

  // Our side. A `paid` row the gateway has no captured payment for is a set we
  // gave away, or a test-mode row in a live database.
  for (const purchase of ours) {
    // No order means the Rs 0 coupon path (A4): there is no gateway payment to
    // find, and that is correct, not a mismatch.
    if (!purchase.orderId) continue;
    // `created` is an abandoned checkout and `refunded` is money already sent
    // back. Neither is money we are holding without a payment behind it.
    if (purchase.status !== 'paid') continue;
    if (capturedOrders.has(purchase.orderId)) continue;

    found.push({
      kind: 'no_payment',
      subject: orderSubject(purchase.orderId),
      orderId: purchase.orderId,
      expectedPaise: toPaise(purchase.amountInr),
      actualPaise: null,
    });
  }

  // OUR OWN DATA WENT STRANGE (issue 35-reconcile-visible). Rows the store
  // could not parse are dropped, which is right, but a dropped purchase makes
  // its captured payment look like `no_purchase`, so the count itself is an
  // alert: it tells Boss that the rest of this night is suspect.
  //
  // One subject per window start, so a re-run of the same night writes
  // nothing, like every other kind. The paise are both null: there is no
  // amount to compare, only a count, and the count is in the detail column.
  if (page.unreadable > 0) {
    found.push({
      kind: 'unreadable_purchase',
      subject: unreadableSubject(window.sinceIso),
      orderId: null,
      expectedPaise: null,
      actualPaise: null,
    });
  }

  // Written one at a time, and a failure on one does not swallow the rest:
  // the first alert is often the one that explains the others.
  let fresh = 0;
  for (const alert of found) {
    if (await store.recordAlert(alert)) fresh += 1;
  }

  return {
    type: 'done',
    payments: listed.length,
    purchases: ours.length,
    alerts: found.length,
    fresh,
    unreadable: page.unreadable,
    subscriptions,
  };
}

// --------------------------------------------------------------------------
// The job around it (issue 35-reconcile-visible)
// --------------------------------------------------------------------------

/** What `jobs/ledger-reconcile.ts` prints and what PM2 reads. */
export interface ReconcileJobResult {
  /** `EXIT_CHECKED` only after a real comparison of the two sides. */
  exitCode: number;
  /** Null when the run threw before it could finish. */
  outcome: ReconcileOutcome | null;
  /** The one log line. Counts and key NAMES only, never a value. */
  line: string;
  /** True when the line belongs on stderr, so it stands out in `pm2 logs`. */
  loud: boolean;
}

/**
 * One night, plus the exit code PM2 needs (issue 35-reconcile-visible).
 *
 * THIS IS THE WHOLE REASON THE JOB FILE IS WIRING. `npm test` must run all of
 * A6 with no network and no key (web/CLAUDE.md), and a file that reads
 * `process.env` at the top cannot be imported by a test. So the decision
 * "may this night report success?" lives here, where a fake drives it.
 *
 * THE RULE: exit 0 means "I compared Razorpay to `purchases`". Nothing else.
 *
 *  * a missing key          -> non-zero. It checked NOTHING.
 *  * a failed Razorpay read -> non-zero.
 *  * a failed purchases read, which includes the row cap -> non-zero.
 *  * alerts found           -> ZERO. An alert is the job WORKING, and a
 *                              non-zero exit would make PM2 treat a caught
 *                              money problem as a crash.
 *
 * Before this issue every one of the first three logged a line and exited 0,
 * and `stop_exit_codes: [0]` made `pm2 list` show a healthy app that had not
 * checked anything since a key was rotated.
 */
export async function runReconcileJob(input: RunReconcileInput): Promise<ReconcileJobResult> {
  const { payments, store } = input;

  // Every missing key by NAME, never by value: a key in a log file is a
  // leaked key.
  const missing = [
    payments.isConfigured() ? null : 'RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET',
    store.isConfigured() ? null : 'NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);

  let outcome: ReconcileOutcome;
  try {
    outcome = await runReconcile(input);
  } catch (error) {
    // The MESSAGE only. Every error the store and the gateway throw carries a
    // fixed string plus an HTTP status by design, never a response body: a
    // PostgREST body quotes constraint names and a 401 body can echo a token.
    const why = error instanceof Error ? error.message : 'unknown error';
    return {
      exitCode: EXIT_CANNOT_CHECK,
      outcome: null,
      line: '[ledger-reconcile] run failed, nothing checked: ' + why,
      loud: true,
    };
  }

  if (outcome.type === 'idle') {
    return {
      exitCode: EXIT_CANNOT_CHECK,
      outcome,
      line: `[ledger-reconcile] not configured, NOTHING checked. Missing: ${missing.join(', ')}`,
      loud: true,
    };
  }

  const line =
    `[ledger-reconcile] window=${input.windowHours ?? RECONCILE_WINDOW_HOURS}h` +
    ` payments=${outcome.payments} subscriptions=${outcome.subscriptions}` +
    ` purchases=${outcome.purchases} unreadable=${outcome.unreadable}` +
    ` alerts=${outcome.alerts} new=${outcome.fresh}`;

  return {
    exitCode: EXIT_CHECKED,
    outcome,
    line,
    // A NEW mismatch stands out in `pm2 logs`. A repeat sighting is routine:
    // Boss has already been told, and the row is on /admin/alerts.
    loud: outcome.fresh > 0,
  };
}
