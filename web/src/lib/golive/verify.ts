/**
 * The rules the Rs 299 test purchase has to satisfy
 * (issue 44-h5-golive-readiness).
 *
 * Pure. Rows in, checks out. No fetch, no env, no Razorpay. Every rule below
 * is copied off a migration rather than invented, and the line it came from is
 * named, so a future change to the money path makes this file obviously wrong
 * instead of quietly stale.
 *
 *   0026_purchases.sql
 *     `amount_inr` is OURS, read from `mock_sets.price_inr` (F-G2).
 *     `status` moves created -> paid -> refunded and never back (A3).
 *   0027_ledger.sql, grant_purchase()
 *     ONE `teacher_ledger` row per purchase (`teacher_ledger_purchase_unique`).
 *     gst      = round(gross - gross / 1.18, 2)        [gst_divisor(), X4]
 *     fee      = clamped to 0 .. gross - gst
 *     net      = gross - gst - fee                     exact, no rounding
 *     teacher  = round(net * share_pct / 100, 2)       [X3, on the NET]
 *     platform = net - teacher                         exact, carries the dust
 *     `share_pct` is a COPY taken at sale time, never a join.
 *     `set_access` valid_until is X2: the teacher's next exam date + 30 days
 *     when one is announced and still ahead, else now() + 12 months, and
 *     'infinity' on the Rs 0 coupon path (A4, 0026).
 *   0027_ledger.sql, refund_purchase()
 *     paid -> refunded, the purchase's OWN `set_access` row deleted, any batch
 *     or admin grant left alone, and the ledger row KEPT: a ledger is
 *     append-only.
 *   0029_reconcile.sql
 *     nothing unresolved in `reconcile_alerts` for this sale.
 *   0034_webhook_grant_first.sql
 *     the action runs first and the `payment_events` row is stored after, so
 *     the event row is the audit trail and its id is the de-dupe.
 *
 * ALL ARITHMETIC IS IN PAISE INTEGERS. `teacher_ledger` is `numeric(12,2)` for
 * the reason spelled out in 0027: 0.1 + 0.2 is a bug report in a payout. A
 * verifier that compared doubles would file a mismatch on a correct row, which
 * is worse than not checking at all.
 */
import type { Check } from './types';
import type { AccessRow, EventRow, LedgerRow, OpenAlertRow, PurchaseRow } from './supabase-reader';

/** Razorpay's capture events, from `src/lib/purchases/webhook.ts`. */
const GRANT_EVENT_TYPES = new Set(['payment.captured', 'order.paid']);
/** Razorpay's refund events, from the same file. */
const REFUND_EVENT_TYPES = new Set(['refund.created', 'refund.processed']);

/** Rupees to whole paise. */
function paise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Paise back to rupees, as a number with at most two decimals. */
function rupees(value: number): number {
  return Math.round(value) / 100;
}

/**
 * Postgres `round(numeric, 0)`: half away from zero.
 *
 * `Math.round` rounds .5 towards positive infinity, which disagrees with
 * Postgres on a negative half. Nothing in the ledger is negative
 * (`teacher_ledger_signs_check`), but the two must not differ by accident.
 */
function roundHalfUp(value: number): number {
  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

export interface SplitInput {
  readonly amountInr: number;
  /** What Razorpay said it kept, in rupees. Clamped, exactly as SQL does. */
  readonly gatewayFeeInr: number;
  readonly sharePct: number;
}

export interface Split {
  readonly gross: number;
  readonly gst: number;
  readonly gatewayFee: number;
  readonly net: number;
  readonly teacherAmount: number;
  readonly platformAmount: number;
}

/**
 * What `grant_purchase()` must have written.
 *
 * `gross * 18 / 118` is `gross - gross / 1.18` rearranged, which keeps the
 * division to ONE step from an integer numerator: the most precise form of the
 * same number, and the form least likely to disagree with Postgres numeric by
 * one paisa.
 */
export function expectedSplit({ amountInr, gatewayFeeInr, sharePct }: SplitInput): Split {
  const grossPaise = paise(amountInr);
  const gstPaise = roundHalfUp((grossPaise * 18) / 118);
  // Clamped twice, exactly as 0027 does: a gateway never pays us, and the fee
  // can never push net below zero and trip `teacher_ledger_signs_check`.
  const feePaise = Math.min(Math.max(paise(gatewayFeeInr), 0), grossPaise - gstPaise);
  const netPaise = grossPaise - gstPaise - feePaise;
  const teacherPaise = roundHalfUp((netPaise * sharePct) / 100);

  return {
    gross: rupees(grossPaise),
    gst: rupees(gstPaise),
    gatewayFee: rupees(feePaise),
    net: rupees(netPaise),
    teacherAmount: rupees(teacherPaise),
    platformAmount: rupees(netPaise - teacherPaise),
  };
}

export type AccessRule = 'forever' | 'exam-date' | '12-months';

export interface AccessEnd {
  readonly rule: AccessRule;
  /** ISO instant, or the literal 'infinity' on the Rs 0 path. */
  readonly iso: string;
}

export interface AccessEndInput {
  /** `teacher_exams.next_exam_date` as YYYY-MM-DD, or null. */
  readonly nextExamDate: string | null;
  /** When the grant ran: the `teacher_ledger` row's `created_at`. */
  readonly grantedAt: string | null;
  readonly amountInr: number;
}

/**
 * Where X2 says the bought set must stop opening.
 *
 * The `> current_date` guard in `grant_purchase()` is the practical reading of
 * "no date set": a teacher who forgot to move last year's date must not sell a
 * set that is already shut when the student taps it.
 */
export function expectedAccessEnd({ nextExamDate, grantedAt, amountInr }: AccessEndInput): AccessEnd {
  // A4, 0026: an Rs 0 coupon writes 'infinity', and `grant_purchase()` only
  // ever raises access with GREATEST, so it stays infinity.
  if (paise(amountInr) === 0) return { rule: 'forever', iso: 'infinity' };

  const granted = grantedAt === null ? Number.NaN : Date.parse(grantedAt);
  const base = Number.isFinite(granted) ? new Date(granted) : new Date(0);

  if (nextExamDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(nextExamDate)) {
    const exam = Date.parse(nextExamDate + 'T00:00:00.000Z');
    if (Number.isFinite(exam)) {
      const open = new Date(exam + 30 * 24 * 60 * 60 * 1000);
      // `(exam_day + 30) > current_date`, with the grant instant as the clock.
      if (open.getTime() > base.getTime()) {
        return { rule: 'exam-date', iso: open.toISOString() };
      }
    }
  }

  // `now() + interval '12 months'`.
  const fallback = new Date(base.getTime());
  fallback.setUTCMonth(fallback.getUTCMonth() + 12);
  return { rule: '12-months', iso: fallback.toISOString() };
}

/**
 * How far a stored `valid_until` may sit from the computed one.
 *
 * `(exam_day + 30)::timestamptz` casts a DATE at midnight in the database's
 * own timezone, and `now()` is read a moment after the row this tool uses as
 * the clock. 36 hours absorbs both and is still nowhere near the smallest real
 * mistake, which is a whole year.
 */
const ACCESS_TOLERANCE_MS = 36 * 60 * 60 * 1000;

function isForever(validUntil: string): boolean {
  const trimmed = validUntil.trim().toLowerCase();
  if (trimmed === 'infinity') return true;
  // Postgres also spells it as a year-9999 timestamp through some drivers.
  return /^9999-/.test(trimmed);
}

function payloadHas(payload: unknown, needle: string): boolean {
  if (needle.trim() === '') return false;
  try {
    return JSON.stringify(payload ?? null).includes(needle);
  } catch {
    return false;
  }
}

/** Every payment id named anywhere in these events' payloads. */
function paymentIdsIn(events: readonly EventRow[]): string[] {
  const out = new Set<string>();
  for (const event of events) {
    let json: string;
    try {
      json = JSON.stringify(event.payload ?? null);
    } catch {
      continue;
    }
    for (const match of json.matchAll(/"(pay_[A-Za-z0-9]{1,40})"/g)) out.add(match[1]);
  }
  return [...out];
}

export interface VerifyInput {
  readonly purchase: PurchaseRow;
  readonly ledger: readonly LedgerRow[];
  readonly access: readonly AccessRow[];
  readonly events: readonly EventRow[];
  readonly openAlerts: readonly OpenAlertRow[];
  /** `teachers.revenue_share_pct` as it is TODAY, for the copy comparison. */
  readonly teacherSharePct: number | null;
  readonly nextExamDate: string | null;
  readonly expectedAmountInr: number;
  readonly refunded: boolean;
}

export function verifyTestPurchase(input: VerifyInput): Check[] {
  const { purchase, ledger, access, events, openAlerts, refunded } = input;
  const checks: Check[] = [];

  // ---- purchase status -----------------------------------------------------
  const wantedStatus = refunded ? 'refunded' : 'paid';
  checks.push(
    purchase.status === wantedStatus
      ? { name: 'purchase status', status: 'PASS', detail: purchase.status }
      : {
          name: 'purchase status',
          status: 'FAIL',
          detail: 'status is ' + purchase.status + ', expected ' + wantedStatus,
          fix: refunded
            ? 'the refund webhook has not been handled; check the Razorpay dashboard refund went through and read the Vercel logs for /api/webhooks/razorpay'
            : 'the capture webhook has not been handled; check the Razorpay dashboard webhook is pointed at this site and read the Vercel logs for /api/webhooks/razorpay',
        },
  );

  // ---- purchase amount -----------------------------------------------------
  checks.push(
    paise(purchase.amountInr) === paise(input.expectedAmountInr)
      ? {
          name: 'purchase amount',
          status: 'PASS',
          detail: 'Rs ' + purchase.amountInr + (purchase.coupon ? ' after coupon ' + purchase.coupon : ''),
        }
      : {
          name: 'purchase amount',
          status: 'FAIL',
          detail: 'Rs ' + purchase.amountInr + ' stored, Rs ' + input.expectedAmountInr + ' expected',
          fix: 'check the mock set price in the database, or pass the real amount with --amount <rupees>',
        },
  );

  // ---- exactly one ledger row ---------------------------------------------
  if (ledger.length === 1) {
    checks.push({ name: 'one teacher_ledger row', status: 'PASS', detail: '1 row' });
  } else if (ledger.length === 0) {
    checks.push({
      name: 'one teacher_ledger row',
      status: 'FAIL',
      detail: '0 rows: the teacher share was never written',
      fix: refunded
        ? 'a ledger is append-only, so a refund must LEAVE the row. A missing row means the sale never wrote one, or something deleted it'
        : 'the capture webhook never reached grant_purchase(); read the Vercel logs for /api/webhooks/razorpay',
    });
  } else {
    checks.push({
      name: 'one teacher_ledger row',
      status: 'FAIL',
      detail: ledger.length + ' rows for one purchase',
      fix: 'teacher_ledger_purchase_unique (0027_ledger.sql) should make this impossible; check the constraint still exists before taking any more money',
    });
  }

  const row = ledger[0];

  // ---- the split -----------------------------------------------------------
  if (!row) {
    checks.push({
      name: 'ledger split',
      status: 'FAIL',
      detail: 'no ledger row to check',
      fix: 'fix the missing ledger row first',
    });
  } else {
    const want = expectedSplit({
      amountInr: purchase.amountInr,
      // The fee is Razorpay's number, not ours to predict, so it is taken from
      // the row and only its range is checked.
      gatewayFeeInr: row.gatewayFee,
      sharePct: row.sharePct,
    });

    const seen =
      'gross ' + row.gross +
      ', gst ' + row.gst +
      ', fee ' + row.gatewayFee +
      ', net ' + row.net +
      ', share ' + row.sharePct + '%' +
      ', teacher ' + row.teacherAmount +
      ', platform ' + row.platformAmount;

    const wrong: string[] = [];
    if (paise(row.gross) !== paise(purchase.amountInr)) {
      wrong.push('gross ' + row.gross + ' is not the Rs ' + purchase.amountInr + ' charged');
    }
    if (paise(row.gst) !== paise(want.gst)) wrong.push('gst should be ' + want.gst);
    if (paise(row.gatewayFee) !== paise(want.gatewayFee)) {
      wrong.push('fee ' + row.gatewayFee + ' is outside 0 .. ' + (want.gross - want.gst));
    }
    if (paise(row.net) !== paise(want.net)) wrong.push('net should be ' + want.net);
    if (paise(row.teacherAmount) !== paise(want.teacherAmount)) {
      wrong.push('teacher should be ' + want.teacherAmount);
    }
    if (paise(row.platformAmount) !== paise(want.platformAmount)) {
      wrong.push('platform should be ' + want.platformAmount);
    }

    checks.push(
      wrong.length === 0
        ? { name: 'ledger split', status: 'PASS', detail: seen }
        : {
            name: 'ledger split',
            status: 'FAIL',
            detail: seen + ' -- ' + wrong.join('; '),
            fix: 'do not pay this out. grant_purchase() in 0027_ledger.sql owns these numbers; a mismatch means the row was written or edited by something else',
          },
    );

    // ---- the share, copied at sale time (X3) -------------------------------
    const live = input.teacherSharePct;
    if (!Number.isFinite(row.sharePct) || row.sharePct < 0 || row.sharePct > 100) {
      checks.push({
        name: 'ledger share copied',
        status: 'FAIL',
        detail: 'share_pct is ' + row.sharePct + ', which is outside 0 to 100',
        fix: 'teacher_ledger_share_check (0027_ledger.sql) should make this impossible; check the constraint still exists',
      });
    } else if (live === null) {
      checks.push({
        name: 'ledger share copied',
        status: 'WARN',
        detail: 'stored share ' + row.sharePct + '%, could not read the teacher row to compare',
      });
    } else if (paise(live) === paise(row.sharePct)) {
      checks.push({
        name: 'ledger share copied',
        status: 'PASS',
        detail: 'stored ' + row.sharePct + '% matches the teacher today',
      });
    } else {
      checks.push({
        name: 'ledger share copied',
        status: 'WARN',
        detail:
          'stored ' + row.sharePct + '%, teacher is on ' + live + '% today. X3 says the COPY wins, so this row is right',
      });
    }
  }

  // ---- the buyer's access --------------------------------------------------
  const own = access.filter((one) => one.source === 'purchase');
  const others = access.filter((one) => one.source !== 'purchase').map((one) => one.source);

  if (refunded) {
    checks.push(
      own.length === 0
        ? {
            name: 'buyer access',
            status: 'PASS',
            detail:
              'no source=purchase row left' +
              (others.length > 0 ? ', and the ' + others.join(' and ') + ' grant survived, as 0027 says it must' : ''),
          }
        : {
            name: 'buyer access',
            status: 'FAIL',
            detail: 'the set is STILL open on source=purchase until ' + own[0].validUntil,
            fix: 'refund_purchase() deletes that row; it did not run, so the student kept a set they were paid back for',
          },
    );
  } else if (own.length === 0) {
    checks.push({
      name: 'buyer access',
      status: 'FAIL',
      detail: 'no set_access row with source=purchase: money taken, set shut',
      fix: 'this is the worst failure there is. Read the Vercel logs for /api/webhooks/razorpay, then open /admin/alerts',
    });
  } else {
    const want = expectedAccessEnd({
      nextExamDate: input.nextExamDate,
      // The ledger row's created_at IS the grant instant: both are written by
      // the same transaction.
      grantedAt: row?.createdAt ?? purchase.createdAt,
      amountInr: purchase.amountInr,
    });
    const seen = own[0].validUntil;

    let ok: boolean;
    if (want.rule === 'forever') {
      ok = isForever(seen);
    } else if (isForever(seen)) {
      // Forever when a window was expected. 0027 raises access with GREATEST
      // and 0026's Rs 0 path writes infinity, so this is legal only when the
      // student had already bought the same set for Rs 0.
      ok = false;
    } else {
      const parsed = Date.parse(seen);
      ok =
        Number.isFinite(parsed) &&
        Math.abs(parsed - Date.parse(want.iso)) <= ACCESS_TOLERANCE_MS;
    }

    checks.push(
      ok
        ? {
            name: 'buyer access',
            status: 'PASS',
            detail: 'source=purchase until ' + seen + ' (X2 rule: ' + want.rule + ')',
          }
        : {
            name: 'buyer access',
            status: 'FAIL',
            detail: 'source=purchase until ' + seen + ', X2 says ' + want.iso + ' (rule: ' + want.rule + ')',
            fix: "check the teacher's next_exam_date for this exam; X2 is next exam date + 30 days, else 12 months from the sale",
          },
    );
  }

  // ---- the payment_events row ---------------------------------------------
  const order = purchase.orderId ?? '';
  const mine = events.filter(
    (event) => payloadHas(event.payload, order) || payloadHas(event.payload, purchase.id),
  );
  const grants = mine.filter((event) => GRANT_EVENT_TYPES.has(event.type));
  const byType = new Map<string, number>();
  for (const event of grants) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  const doubled = [...byType.entries()].filter(([, count]) => count > 1);

  if (grants.length === 0) {
    checks.push({
      name: 'payment_events row',
      status: 'FAIL',
      detail:
        'no payment.captured or order.paid row naming this sale' +
        (order === '' ? ' (and the purchase has no Razorpay order id)' : ''),
      fix: 'the webhook never arrived. Check the Razorpay dashboard webhook URL, its secret, and that payment.captured is subscribed',
    });
  } else if (doubled.length > 0) {
    checks.push({
      name: 'payment_events row',
      status: 'FAIL',
      detail: doubled.map(([type, count]) => count + ' rows of ' + type).join(', '),
      fix: 'the event_id primary key (0027_ledger.sql) should make a duplicate impossible, so two rows means two different event ids for one payment. Check nothing is rewriting the id',
    });
  } else if (byType.size > 1) {
    checks.push({
      name: 'payment_events row',
      status: 'PASS',
      detail:
        [...byType.keys()].join(' and ') +
        ' both arrived, which is normal when both are subscribed; grant_purchase() refused the second',
    });
  } else {
    checks.push({
      name: 'payment_events row',
      status: 'PASS',
      detail: '1 row of ' + [...byType.keys()][0],
    });
  }

  // ---- no open reconcile alert for this sale ------------------------------
  const payments = paymentIdsIn(mine);
  const hits = openAlerts.filter((alert) => {
    if (order !== '' && alert.orderId === order) return true;
    if (order !== '' && alert.subject.includes(order)) return true;
    if (alert.subject.includes(purchase.id)) return true;
    return payments.some((id) => alert.subject === id || alert.orderId === id);
  });

  checks.push(
    hits.length === 0
      ? { name: 'reconcile alerts', status: 'PASS', detail: 'nothing open for this sale' }
      : {
          name: 'reconcile alerts',
          status: 'FAIL',
          detail: hits.map((alert) => alert.kind).join(', '),
          fix: 'open /admin/alerts and resolve it before taking any more money',
        },
  );

  // ---- the refund path ----------------------------------------------------
  //
  // The app DOES have refund handling, and this says where it is so nobody has
  // to go looking: `refund_purchase()` in 0027_ledger.sql, called by
  // `src/lib/purchases/webhook.ts` on `refund.created` or `refund.processed`.
  // It moves paid -> refunded, deletes the purchase's own `set_access` row,
  // and leaves the ledger row alone because a ledger is append-only.
  if (refunded) {
    const refunds = mine.filter((event) => REFUND_EVENT_TYPES.has(event.type));
    checks.push(
      refunds.length > 0
        ? {
            name: 'refund path',
            status: 'PASS',
            detail:
              refunds.map((event) => event.type).join(', ') +
              ' arrived, so the webhook called refund_purchase() (0027_ledger.sql): paid -> refunded, the purchase set_access row deleted, the ledger row kept',
          }
        : {
            name: 'refund path',
            status: 'FAIL',
            detail:
              'no refund.created or refund.processed row names this sale, so refund_purchase() (0027_ledger.sql) was never called by the webhook',
            fix: 'in the Razorpay dashboard, subscribe refund.created and refund.processed on the webhook, then refund again',
          },
    );
  }

  return checks;
}
