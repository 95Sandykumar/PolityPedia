/**
 * The Rs 299 test-purchase verifier, over FAKE ROWS
 * (issue 44-h5-golive-readiness).
 *
 * This is the check that stands between Boss and a first real sale that went
 * half-way: money taken and the set shut, or the set open and the teacher's
 * share never written. Every rule below is read off the migrations, not
 * invented here:
 *
 *   0026  purchases: amount is ours, status created -> paid -> refunded.
 *   0027  grant_purchase(): one teacher_ledger row per purchase (UNIQUE),
 *         gst = round(gross - gross / 1.18, 2), net = gross - gst - fee,
 *         teacher = round(net * share_pct / 100, 2), platform = net - teacher,
 *         share_pct COPIED at sale time, set_access for X2's window.
 *   0027  refund_purchase(): paid -> refunded, the purchase's own set_access
 *         row deleted, the ledger row KEPT (a ledger is append-only).
 *   0029  reconcile_alerts: nothing open for this sale.
 *   0034  the webhook runs the action first, then stores the event id.
 *
 * No key, no network, no Razorpay. Rows in, PASS/FAIL out.
 */
import { describe, expect, it } from 'vitest';
import type { AccessRow, EventRow, LedgerRow, OpenAlertRow, PurchaseRow } from '../supabase-reader';
import { expectedAccessEnd, expectedSplit, verifyTestPurchase, type VerifyInput } from '../verify';

const ORDER = 'order_T1';
const PAID_AT = '2026-11-20T10:01:00.000Z';

const PURCHASE: PurchaseRow = {
  id: 'p-1',
  userId: 'u-1',
  setId: 's-1',
  orderId: ORDER,
  amountInr: 299,
  coupon: null,
  status: 'paid',
  createdAt: '2026-11-20T10:00:00.000Z',
};

const LEDGER: LedgerRow = {
  id: 'l-1',
  teacherId: 't-1',
  purchaseId: 'p-1',
  gross: 299,
  gst: 45.61,
  gatewayFee: 7.06,
  net: 246.33,
  sharePct: 60,
  teacherAmount: 147.8,
  platformAmount: 98.53,
  payoutId: null,
  createdAt: PAID_AT,
};

const ACCESS: AccessRow = {
  userId: 'u-1',
  setId: 's-1',
  source: 'purchase',
  // No next exam date announced, so X2's 12-month fallback from the grant.
  validUntil: '2027-11-20T10:01:00.000Z',
};

const CAPTURE: EventRow = {
  eventId: 'evt_1',
  type: 'payment.captured',
  payload: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: ORDER, fee: 706 } } } },
  receivedAt: PAID_AT,
};

const REFUND: EventRow = {
  eventId: 'evt_2',
  type: 'refund.processed',
  payload: { event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } }, payment: { entity: { id: 'pay_1', order_id: ORDER } } } },
  receivedAt: '2026-11-20T11:00:00.000Z',
};

function input(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    purchase: PURCHASE,
    ledger: [LEDGER],
    access: [ACCESS],
    events: [CAPTURE],
    openAlerts: [],
    teacherSharePct: 60,
    nextExamDate: null,
    expectedAmountInr: 299,
    refunded: false,
    ...over,
  };
}

function statusOf(checks: readonly { name: string; status: string }[], part: string): string {
  const found = checks.find((check) => check.name.toLowerCase().includes(part.toLowerCase()));
  if (!found) throw new Error('no check named ' + part + ' in ' + checks.map((c) => c.name).join(', '));
  return found.status;
}

describe('expectedSplit', () => {
  it('is the Rs 299 sale, to the paisa', () => {
    expect(expectedSplit({ amountInr: 299, gatewayFeeInr: 7.06, sharePct: 60 })).toEqual({
      gross: 299,
      gst: 45.61,
      gatewayFee: 7.06,
      net: 246.33,
      teacherAmount: 147.8,
      platformAmount: 98.53,
    });
  });

  it('keeps gst + fee + net exactly the gross, and the two shares exactly the net', () => {
    for (const amountInr of [0, 1, 199, 299, 399, 1000]) {
      for (const sharePct of [0, 33, 50, 60, 100]) {
        const split = expectedSplit({ amountInr, gatewayFeeInr: amountInr * 0.0236, sharePct });
        expect(split.gst + split.gatewayFee + split.net).toBeCloseTo(split.gross, 6);
        expect(split.teacherAmount + split.platformAmount).toBeCloseTo(split.net, 6);
      }
    }
  });

  it('clamps a silly fee so net can never go below zero', () => {
    const split = expectedSplit({ amountInr: 299, gatewayFeeInr: 400000, sharePct: 60 });
    expect(split.net).toBe(0);
    expect(split.gatewayFee).toBe(253.39);
  });
});

describe('expectedAccessEnd', () => {
  it('is the exam date plus 30 days when the teacher announced one (X2)', () => {
    const end = expectedAccessEnd({ nextExamDate: '2027-06-01', grantedAt: PAID_AT, amountInr: 299 });
    expect(end.rule).toBe('exam-date');
    expect(end.iso.slice(0, 10)).toBe('2027-07-01');
  });

  it('falls back to 12 months when no date is set, or the date is already past', () => {
    expect(expectedAccessEnd({ nextExamDate: null, grantedAt: PAID_AT, amountInr: 299 }).rule).toBe('12-months');
    expect(
      expectedAccessEnd({ nextExamDate: '2020-01-01', grantedAt: PAID_AT, amountInr: 299 }).rule,
    ).toBe('12-months');
  });

  it('is forever on the Rs 0 coupon path (A4)', () => {
    expect(expectedAccessEnd({ nextExamDate: null, grantedAt: PAID_AT, amountInr: 0 }).rule).toBe('forever');
  });
});

describe('verifyTestPurchase, the happy Rs 299 sale', () => {
  const checks = verifyTestPurchase(input());

  it('passes every check', () => {
    expect(checks.filter((check) => check.status !== 'PASS')).toEqual([]);
  });

  it('prints the raw numbers, so Boss can eye-check the split', () => {
    const split = checks.find((check) => check.name.toLowerCase().includes('split'));
    expect(split?.detail).toContain('246.33');
    expect(split?.detail).toContain('147.8');
  });
});

describe('verifyTestPurchase, every way it must fail', () => {
  it('fails a wrong amount', () => {
    const checks = verifyTestPurchase(input({ purchase: { ...PURCHASE, amountInr: 199 } }));
    expect(statusOf(checks, 'amount')).toBe('FAIL');
  });

  it('fails a purchase that never turned paid', () => {
    const checks = verifyTestPurchase(input({ purchase: { ...PURCHASE, status: 'created' } }));
    expect(statusOf(checks, 'status')).toBe('FAIL');
  });

  it('fails two ledger rows for one purchase', () => {
    const checks = verifyTestPurchase(input({ ledger: [LEDGER, { ...LEDGER, id: 'l-2' }] }));
    expect(statusOf(checks, 'one teacher_ledger row')).toBe('FAIL');
  });

  it('fails no ledger row at all', () => {
    const checks = verifyTestPurchase(input({ ledger: [] }));
    expect(statusOf(checks, 'one teacher_ledger row')).toBe('FAIL');
  });

  it('fails a split that does not add up', () => {
    const checks = verifyTestPurchase(input({ ledger: [{ ...LEDGER, teacherAmount: 200, platformAmount: 46.33 }] }));
    expect(statusOf(checks, 'split')).toBe('FAIL');
  });

  it('fails a share that was not copied at sale time', () => {
    const checks = verifyTestPurchase(input({ ledger: [{ ...LEDGER, sharePct: 999 }] }));
    expect(statusOf(checks, 'share')).toBe('FAIL');
  });

  it('warns, and does not fail, when the teacher share changed AFTER the sale', () => {
    // X3: the copy is the point. A live share of 70 against a stored 60 is the
    // feature working, so it is a WARN with both numbers, never a FAIL.
    const checks = verifyTestPurchase(input({ teacherSharePct: 70 }));
    expect(statusOf(checks, 'share')).toBe('WARN');
  });

  it('fails missing access', () => {
    const checks = verifyTestPurchase(input({ access: [] }));
    expect(statusOf(checks, 'access')).toBe('FAIL');
  });

  it('fails access that ends in the wrong place', () => {
    const checks = verifyTestPurchase(input({ access: [{ ...ACCESS, validUntil: '2026-11-21T00:00:00.000Z' }] }));
    expect(statusOf(checks, 'access')).toBe('FAIL');
  });

  it('fails a duplicate event row for one payment', () => {
    const checks = verifyTestPurchase(input({ events: [CAPTURE, { ...CAPTURE, eventId: 'evt_1b' }] }));
    expect(statusOf(checks, 'payment_events')).toBe('FAIL');
  });

  it('fails when the webhook never arrived', () => {
    const checks = verifyTestPurchase(input({ events: [] }));
    expect(statusOf(checks, 'payment_events')).toBe('FAIL');
  });

  it('fails an open reconcile alert for this sale', () => {
    const alert: OpenAlertRow = {
      id: 'a-1',
      kind: 'amount_mismatch',
      subject: 'pay_1',
      orderId: ORDER,
      createdAt: PAID_AT,
    };
    const checks = verifyTestPurchase(input({ openAlerts: [alert] }));
    expect(statusOf(checks, 'reconcile')).toBe('FAIL');
    expect(checks.find((check) => check.name.toLowerCase().includes('reconcile'))?.detail).toContain(
      'amount_mismatch',
    );
  });

  it('ignores an open alert about somebody else', () => {
    const alert: OpenAlertRow = {
      id: 'a-2',
      kind: 'no_payment',
      subject: 'purchases:2026-11-01',
      orderId: 'order_OTHER',
      createdAt: PAID_AT,
    };
    expect(statusOf(verifyTestPurchase(input({ openAlerts: [alert] })), 'reconcile')).toBe('PASS');
  });
});

describe('verifyTestPurchase --refunded', () => {
  it('passes a clean refund: status refunded, access gone, ledger row kept', () => {
    const checks = verifyTestPurchase(
      input({
        refunded: true,
        purchase: { ...PURCHASE, status: 'refunded' },
        access: [],
        events: [CAPTURE, REFUND],
      }),
    );
    expect(checks.filter((check) => check.status === 'FAIL')).toEqual([]);
  });

  it('names refund_purchase(), because the refund path IS built', () => {
    const checks = verifyTestPurchase(
      input({ refunded: true, purchase: { ...PURCHASE, status: 'refunded' }, access: [], events: [CAPTURE, REFUND] }),
    );
    const refund = checks.find((check) => check.name.toLowerCase().includes('refund'));
    expect(refund?.detail).toContain('refund_purchase');
  });

  it('fails a purchase that is still paid', () => {
    const checks = verifyTestPurchase(input({ refunded: true, access: [], events: [CAPTURE, REFUND] }));
    expect(statusOf(checks, 'status')).toBe('FAIL');
  });

  it('fails when the set is still open after a refund', () => {
    const checks = verifyTestPurchase(
      input({
        refunded: true,
        purchase: { ...PURCHASE, status: 'refunded' },
        access: [ACCESS],
        events: [CAPTURE, REFUND],
      }),
    );
    expect(statusOf(checks, 'access')).toBe('FAIL');
  });

  it('fails when the ledger row was deleted, because a ledger is append-only', () => {
    const checks = verifyTestPurchase(
      input({
        refunded: true,
        purchase: { ...PURCHASE, status: 'refunded' },
        access: [],
        ledger: [],
        events: [CAPTURE, REFUND],
      }),
    );
    expect(statusOf(checks, 'one teacher_ledger row')).toBe('FAIL');
  });

  it('fails when no refund webhook ever arrived', () => {
    const checks = verifyTestPurchase(
      input({ refunded: true, purchase: { ...PURCHASE, status: 'refunded' }, access: [], events: [CAPTURE] }),
    );
    expect(statusOf(checks, 'refund')).toBe('FAIL');
  });
});
