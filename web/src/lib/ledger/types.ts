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
export type ReconcileKind =
  | 'no_purchase'
  | 'not_paid'
  | 'amount_mismatch'
  | 'no_payment'
  /**
   * The job read our own `purchases` and could not parse N rows
   * (issue 35-reconcile-visible). Not a gateway mismatch: a problem with OUR
   * data, which makes every other conclusion of that night suspect, because a
   * dropped purchase makes its captured payment look like `no_purchase`.
   */
  | 'unreadable_purchase';

/** The `unreadable_purchase` subject. One strange night is one line. */
export function unreadableSubject(sinceIso: string): string {
  return 'purchases:' + sinceIso;
}

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
  /**
   * Purchase rows the store could NOT parse (issue 35-reconcile-visible).
   * Non-zero files one `unreadable_purchase` alert, because every other
   * conclusion of that night is suspect.
   */
  unreadable: number;
  /**
   * Captured payments skipped as monthly plan charges
   * (issue 35-reconcile-visible). Logged so a sudden jump is visible: it is
   * the number of payments this job deliberately did not check.
   */
  subscriptions: number;
}

/**
 * The exit code PM2 reads. 0 ONLY after a real check
 * (issue 35-reconcile-visible).
 */
export const EXIT_CHECKED = 0;

/**
 * The job could not compare the two sides: a key is missing, or a read threw.
 *
 * `ecosystem.config.cjs` has `stop_exit_codes: [0]`, so before this issue a
 * rotated Razorpay key logged "not configured", exited 0, and `pm2 list`
 * showed a healthy app that had checked nothing since the key changed.
 */
export const EXIT_CANNOT_CHECK = 1;

// --------------------------------------------------------------------------
// The nightly job, behind one interface
// --------------------------------------------------------------------------

/**
 * One read of our own purchases, PLUS how much of it we could not read
 * (issue 35-reconcile-visible).
 *
 * The count travels with the rows on purpose. A bare array cannot say "and 12
 * more I dropped", so the dropped ones used to vanish, and a dropped purchase
 * makes its captured payment look like `no_purchase`.
 */
export interface ReconcilePurchasePage {
  purchases: ReconcilePurchase[];
  /** Rows whose shape we could not parse. Dropped, but never silently. */
  unreadable: number;
}

export interface ReconcileStore {
  /** False when the Supabase env vars are missing, so the job can idle. */
  isConfigured(): boolean;
  /**
   * Our own purchases created at or after `sinceIso`.
   *
   * THROWS when the read failed or when the row cap was reached, because a
   * truncated list of our own sales turns every sale the job did not see into
   * a `no_payment` alert about a real, correct sale.
   */
  listPurchases(input: { sinceIso: string }): Promise<ReconcilePurchasePage>;
  /**
   * `record_reconcile_alert()`. TRUE when the row was new, FALSE when this
   * exact `(kind, subject)` is already on Boss's list.
   */
  recordAlert(input: ReconcileAlertInput): Promise<boolean>;
}

// --------------------------------------------------------------------------
// The admin alerts screen (issue 35-reconcile-visible)
// --------------------------------------------------------------------------

/** One open alert, as `/admin/alerts` shows it. */
export interface ReconcileAlertRow {
  id: string;
  kind: ReconcileKind;
  /** The payment id, or `order:<order id>`. What a human looks it up by. */
  subject: string;
  orderId: string | null;
  /** What OUR row said, in paise. */
  expectedPaise: number | null;
  /** What RAZORPAY said, in paise. */
  actualPaise: number | null;
  /** When the job first saw it. The first sighting is the one kept (0029). */
  createdAtIso: string;
}

/** Our own route the alerts page calls. Holds no key. */
export const ADMIN_ALERTS_PATH = '/api/admin/alerts';

/**
 * Server side. Carries the ADMIN'S OWN access token, so the
 * `reconcile_alerts_admin_all` policy in 0029 is the gate: a teacher reading
 * this from a patched build gets zero rows from Postgres, not a filtered page.
 */
export interface AlertsClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** Unresolved alerts, newest first. */
  listOpen(): Promise<ReconcileAlertRow[]>;
  /**
   * Set `resolved_at` on one STILL-OPEN alert. TRUE when this call resolved
   * it, FALSE when it was already resolved, which is a real answer and not an
   * error: somebody else got there first. The row is NEVER deleted; that
   * would erase the trail of a money problem.
   */
  resolve(id: string): Promise<boolean>;
}

/** Browser side. Calls our own route; never sees a Supabase key. */
export interface BrowserAlertsClient {
  list(): Promise<ReconcileAlertRow[]>;
  resolve(id: string): Promise<boolean>;
}

/**
 * Paise as a rupee string, to the paisa, for the alerts screen.
 *
 * Paise and NOT rupees is what the table stores (0029: "converting before
 * storing is how a rounding argument starts"), so the division happens once,
 * here, at the edge. `null` means the side had nothing at all, which is itself
 * the information: a `no_purchase` alert has no expected amount.
 */
export function alertRupees(paise: number | null, lang: 'en' | 'hi'): string {
  // A plain hyphen, in both languages: this side of the comparison had NO
  // amount, which is not the same as zero rupees.
  if (paise === null || !Number.isFinite(paise)) return '-';
  const whole = (Math.max(0, paise) / 100).toFixed(2);
  return lang === 'hi' ? `₹${whole}` : `Rs ${whole}`;
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
  /**
   * Rows the store dropped (issue 35-reconcile-visible). The real store counts
   * them; this is how a test drives the alert they file.
   */
  unreadable?: number;
  /**
   * Throw from `listPurchases`, so the job's "I could not check our own side"
   * exit code is testable. The real store throws for a failed read AND for
   * the row cap.
   */
  failPurchases?: boolean;
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
      if (options.failPurchases) {
        throw new Error('Supabase purchases read failed with status 500');
      }
      return {
        purchases: [...(options.purchases ?? [])],
        unreadable: options.unreadable ?? 0,
      };
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

export interface FakeAlertsClientOptions {
  configured?: boolean;
  /** The OPEN alerts. `resolve` answers true only for an id that is in here. */
  alerts?: readonly ReconcileAlertRow[];
  /** Throw from both calls, so the route's 502 paths are testable. */
  fail?: boolean;
}

export interface FakeAlertsClient extends AlertsClient {
  /** How many times the list was read. 0 proves a refusal read nothing. */
  listCalls: number;
  /** Every id `resolve` was called with, in order. */
  resolved: string[];
}

/**
 * The one fake alerts client in the suite.
 *
 * `resolve` answers TRUE only for an id that is still open, which is how
 * PostgREST really behaves for `?id=eq.<id>&resolved_at=is.null`: the update
 * matches zero rows when somebody already resolved it, and that is a real
 * answer rather than an error.
 */
export function createFakeAlertsClient(
  options: FakeAlertsClientOptions = {},
): FakeAlertsClient {
  const open = [...(options.alerts ?? [])];
  const configured = options.configured ?? true;

  const fake: FakeAlertsClient = {
    listCalls: 0,
    resolved: [],
    isConfigured() {
      return configured;
    },
    async listOpen() {
      fake.listCalls += 1;
      if (options.fail) throw new Error('Supabase alerts read failed with status 500');
      return [...open];
    },
    async resolve(id: string) {
      fake.resolved.push(id);
      if (options.fail) throw new Error('Supabase alert resolve failed with status 500');
      return open.some((one) => one.id === id);
    },
  };

  return fake;
}
