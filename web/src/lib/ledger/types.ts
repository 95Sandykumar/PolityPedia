/**
 * The reconcile and payout contract (issue 29-ledger-reconcile-payouts).
 *
 * Two jobs, one file, because they share the same money:
 *
 *  * A6, the nightly reconcile. Razorpay's payments versus our `purchases`,
 *    and a row in `reconcile_alerts` for anything that does not line up.
 *  * X1, the monthly manual bank transfer. What is owed per teacher per
 *    month, and a `payouts` row when Boss has sent it.
 *
 * Supabase sits behind the interfaces at the bottom, so tests fake them: no
 * real network call and no real key anywhere in the suite (web/CLAUDE.md).
 * `createFakeReconcileStore()` is that fake, and it lives here rather than in
 * a test file because the job wiring and the route tests both want it.
 *
 *  * `ReconcileStore`  -- the nightly job. SERVICE ROLE: it is nobody's
 *                         session, and `record_reconcile_alert()` is granted
 *                         to `service_role` alone.
 *  * `PayoutsClient`   -- the admin screen, server side. Carries the ADMIN'S
 *                         OWN access token, so the `is_admin()` guard inside
 *                         `payout_report()` and `mark_payout_paid()` decides.
 *  * `BrowserPayoutsClient` -- the page. Posts to our own route, sees no key.
 */
import type { PurchaseStatus } from '@/lib/purchases/types';

/**
 * How far back the nightly reconcile looks.
 *
 * 48 and not 24, on purpose. The job runs at 2 AM, so a 24-hour window has a
 * hard edge an hour either side of itself: a payment at 01:55 could be read
 * before our own webhook finished writing the purchase, and would be filed as
 * a mismatch that fixes itself. Overlapping the windows costs nothing, because
 * `(kind, subject)` is UNIQUE in the database and a repeat sighting writes
 * nothing.
 */
export const RECONCILE_WINDOW_HOURS = 48;

const HOUR_MS = 3_600_000;

/**
 * The only Razorpay status that means money actually moved.
 *
 * `authorized` is a hold we never use (0026 sends `payment_capture: 1`), and
 * `created`, `failed` and `refunded` are not money we are holding. Treating
 * any of them as a sale would file an alert about a student who was never
 * charged.
 */
export const CAPTURED_STATUS = 'captured';

/** Our own purchase row, as the reconcile reads it. */
export interface ReconcilePurchase {
  id: string;
  /** NULL on the Rs 0 coupon path, so there is nothing to reconcile. */
  orderId: string | null;
  /** Rupees we think were charged. The gateway speaks paise. */
  amountInr: number;
  status: PurchaseStatus;
}

/**
 * What kind of mismatch this is. Same list as `reconcile_alerts_kind_check`,
 * worst first:
 *
 *   `no_purchase`     money taken, no row of ours. A student paid for nothing.
 *   `not_paid`        we have the row, it never turned `paid`. Webhook lost.
 *   `amount_mismatch` both say paid, and disagree about how much.
 *   `no_payment`      our row says `paid`, the gateway captured nothing.
 */
export type ReconcileKind = 'no_purchase' | 'not_paid' | 'amount_mismatch' | 'no_payment';

export interface ReconcileAlertInput {
  kind: ReconcileKind;
  /**
   * What names the problem: the Razorpay payment id, or `order:<order id>`
   * when there is no payment to name. Half of the UNIQUE that makes a nightly
   * re-run free.
   */
  subject: string;
  orderId: string | null;
  /** What OUR row says, in paise. NULL when we have no row. */
  expectedPaise: number | null;
  /** What RAZORPAY says, in paise. NULL when it has no payment. */
  actualPaise: number | null;
}

/** The `no_payment` subject. One function, so the job and a reader agree. */
export function orderSubject(orderId: string): string {
  return 'order:' + orderId;
}

/** The window the job asks both sides about, from one clock reading. */
export function reconcileWindow(now: number, hours: number = RECONCILE_WINDOW_HOURS) {
  const sinceMs = now - hours * HOUR_MS;
  return {
    fromSeconds: Math.floor(sinceMs / 1000),
    toSeconds: Math.floor(now / 1000),
    sinceIso: new Date(sinceMs).toISOString(),
  };
}

/** One line in the PM2 log, and the job's whole result. */
export interface ReconcileOutcome {
  /** `idle` means a key is missing and NOTHING was checked. */
  type: 'done' | 'idle';
  /** Payments Razorpay reported in the window. */
  payments: number;
  /** Purchases of ours in the window. */
  purchases: number;
  /** Mismatches seen, new or already known. */
  alerts: number;
  /** Mismatches that were NEW. A second run of the same night reports 0. */
  fresh: number;
}

// --------------------------------------------------------------------------
// The nightly job, behind one interface
// --------------------------------------------------------------------------

export interface ReconcileStore {
  /** False when the Supabase env vars are missing, so the job can idle. */
  isConfigured(): boolean;
  /** Our own purchases created at or after `sinceIso`. */
  listPurchases(input: { sinceIso: string }): Promise<ReconcilePurchase[]>;
  /**
   * `record_reconcile_alert()`. TRUE when the row was new, FALSE when this
   * exact `(kind, subject)` is already on Boss's list.
   */
  recordAlert(input: ReconcileAlertInput): Promise<boolean>;
}

// --------------------------------------------------------------------------
// The payout screen, behind one interface
// --------------------------------------------------------------------------

/** One line of the payout report: one teacher, one month, one number. */
export interface PayoutLine {
  teacherId: string;
  /** `YYYY-MM`, in Asia/Kolkata. See `ledger_month()` in 0029. */
  period: string;
  saleCount: number;
  /** Rupees owed to the teacher, to the paisa. */
  amountInr: number;
}

/** What `mark_payout_paid()` answers. `null` means nothing was owed. */
export type MarkPaidResult = { payoutId: string } | { payoutId: null };

export interface MarkPaidInput {
  teacherId: string;
  period: string;
  /** The bank reference, so Boss can find the transfer again. Optional. */
  reference?: string | null;
}

/** Server side. Carries the admin's own access token, so `is_admin()` decides. */
export interface PayoutsClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** `payout_report()`. Unpaid earnings per teacher per month. */
  report(period?: string | null): Promise<PayoutLine[]>;
  /** `mark_payout_paid()`. One transaction: payout row plus linked ledger rows. */
  markPaid(input: MarkPaidInput): Promise<MarkPaidResult>;
}

/** Our own route the admin screen posts to. Holds no key. */
export const ADMIN_PAYOUTS_PATH = '/api/admin/payouts';

/** Browser side. Calls our own route; never sees a Supabase key. */
export interface BrowserPayoutsClient {
  list(): Promise<PayoutLine[]>;
  markPaid(input: MarkPaidInput): Promise<MarkPaidResult>;
}

/** `YYYY-MM`, the same shape as `payouts_period_check` in 0027. */
const PERIOD_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function isPayoutPeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_RE.test(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Rupees the way the dictionary writes them, to the paisa. */
export function payoutRupees(amountInr: number, lang: 'en' | 'hi'): string {
  const safe = Number.isFinite(amountInr) ? Math.max(0, amountInr) : 0;
  const whole = safe.toFixed(2);
  return lang === 'hi' ? `₹${whole}` : `Rs ${whole}`;
}

// --------------------------------------------------------------------------
// The fakes
// --------------------------------------------------------------------------

export interface FakeReconcileStoreOptions {
  configured?: boolean;
  purchases?: readonly ReconcilePurchase[];
}

export interface FakeReconcileStore extends ReconcileStore {
  /** Every alert that was actually WRITTEN, in order. A repeat is not here. */
  alerts: ReconcileAlertInput[];
  /** Every `listPurchases` call, so a test can check the window. */
  listed: { sinceIso: string }[];
}

/**
 * The one fake store in the suite. It keeps its own `(kind, subject)` set, so
 * a second `recordAlert` for the same problem answers FALSE exactly the way
 * `on conflict do nothing` does in Postgres. That is what makes the "run it
 * twice" test test something.
 */
export function createFakeReconcileStore(
  options: FakeReconcileStoreOptions = {},
): FakeReconcileStore {
  const alerts: ReconcileAlertInput[] = [];
  const listed: { sinceIso: string }[] = [];
  const seen = new Set<string>();
  const configured = options.configured ?? true;

  return {
    alerts,
    listed,
    isConfigured() {
      return configured;
    },
    async listPurchases(input: { sinceIso: string }) {
      listed.push(input);
      return [...(options.purchases ?? [])];
    },
    async recordAlert(input: ReconcileAlertInput) {
      const key = input.kind + '\u0000' + input.subject;
      if (seen.has(key)) return false;
      seen.add(key);
      alerts.push(input);
      return true;
    },
  };
}
