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
import { type PaymentRecord, type Payments } from '@/lib/purchases/types';
import { PAISE_PER_RUPEE } from '@/lib/purchases/types';
import {
  CAPTURED_STATUS,
  orderSubject,
  reconcileWindow,
  RECONCILE_WINDOW_HOURS,
  type ReconcileAlertInput,
  type ReconcileOutcome,
  type ReconcilePurchase,
  type ReconcileStore,
} from './types';

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
  const idle: ReconcileOutcome = { type: 'idle', payments: 0, purchases: 0, alerts: 0, fresh: 0 };

  // A missing key is NOT a quiet night. Reading one side and not the other
  // would make every sale look like a mismatch and bury Boss in alerts about
  // nothing, so neither side is read at all.
  if (!payments.isConfigured() || !store.isConfigured()) return idle;

  const window = reconcileWindow(now, windowHours);

  const listed = await payments.listPayments({
    fromSeconds: window.fromSeconds,
    toSeconds: window.toSeconds,
  });
  const ours = await store.listPurchases({ sinceIso: window.sinceIso });

  // An order id is UNIQUE on `purchases` (A1, 0026), so this never collapses
  // two real rows into one.
  const byOrder = new Map<string, ReconcilePurchase>();
  for (const purchase of ours) {
    if (purchase.orderId) byOrder.set(purchase.orderId, purchase);
  }

  const found: ReconcileAlertInput[] = [];
  /** Orders the gateway captured, so our side knows what it has seen. */
  const capturedOrders = new Set<string>();

  for (const payment of listed) {
    // Only money that actually moved. An `authorized`, `failed` or `created`
    // payment is not a sale, and filing it as one would send Boss chasing a
    // student who was never charged.
    if (payment.status !== CAPTURED_STATUS) continue;
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
  };
}
