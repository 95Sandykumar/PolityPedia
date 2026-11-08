/**
 * The verifier's wiring: find the purchase, read around it, answer a table
 * (issue 44-h5-golive-readiness).
 *
 * `jobs/verify-test-purchase.ts` is a thin wrapper around this. Boss will type
 * whichever id is in front of them on go-live day, which is usually the
 * Razorpay PAYMENT id, so all three spellings have to work.
 *
 * Fake reader, no fetch, no key.
 */
import { describe, expect, it } from 'vitest';
import { fakeGoliveReader } from '../fake-reader';
import { runVerifyTestPurchase } from '../verify-run';
import type { AccessRow, EventRow, LedgerRow, PurchaseRow } from '../supabase-reader';

const PURCHASE_ID = '8f6b6ac8-6c2b-4f07-9b9e-2f0b1f3a1111';
const ORDER = 'order_T1';
const PAID_AT = '2026-11-20T10:01:00.000Z';

const PURCHASE: PurchaseRow = {
  id: PURCHASE_ID,
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
  purchaseId: PURCHASE_ID,
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
  validUntil: '2027-11-20T10:01:00.000Z',
};

const CAPTURE: EventRow = {
  eventId: 'evt_1',
  type: 'payment.captured',
  payload: {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_RzP1', order_id: ORDER, fee: 706 } } },
  },
  receivedAt: PAID_AT,
};

function reader(over: Record<string, unknown> = {}) {
  return fakeGoliveReader({
    purchases: [PURCHASE],
    ledger: [LEDGER],
    access: [ACCESS],
    events: [CAPTURE],
    openAlerts: [],
    owner: { teacherId: 't-1', examId: 'e-1' },
    sharePct: 60,
    nextExamDate: null,
    ...over,
  });
}

describe('runVerifyTestPurchase, finding the purchase', () => {
  it('finds it by purchase uuid', async () => {
    const result = await runVerifyTestPurchase({ argv: [PURCHASE_ID], reader: reader() });
    expect(result.exitCode).toBe(0);
    expect(result.checks.filter((check) => check.status === 'FAIL')).toEqual([]);
  });

  it('finds it by Razorpay order id', async () => {
    const result = await runVerifyTestPurchase({ argv: [ORDER], reader: reader() });
    expect(result.exitCode).toBe(0);
  });

  it('finds it by Razorpay payment id, through payment_events', async () => {
    const result = await runVerifyTestPurchase({ argv: ['pay_RzP1'], reader: reader() });
    expect(result.exitCode).toBe(0);
  });

  it('fails clearly when nothing was named', async () => {
    const result = await runVerifyTestPurchase({ argv: [], reader: reader() });
    expect(result.exitCode).toBe(1);
    expect(result.checks).toHaveLength(1);
    expect(result.text).toContain('pay_');
    expect(result.text).not.toContain('    at ');
  });

  it('fails clearly on a word that is no kind of id', async () => {
    const result = await runVerifyTestPurchase({ argv: ['yesterday'], reader: reader() });
    expect(result.exitCode).toBe(1);
    expect(result.checks).toHaveLength(1);
  });

  it('fails when the purchase is simply not there', async () => {
    const result = await runVerifyTestPurchase({ argv: ['order_NOPE'], reader: reader() });
    expect(result.exitCode).toBe(1);
    expect(result.checks[0].name).toContain('purchase found');
  });

  it('fails when a payment id names no stored event', async () => {
    const result = await runVerifyTestPurchase({ argv: ['pay_NOPE'], reader: reader() });
    expect(result.exitCode).toBe(1);
    expect(result.checks[0].status).toBe('FAIL');
  });
});

describe('runVerifyTestPurchase, flags', () => {
  it('takes the amount from --amount', async () => {
    const cheap: PurchaseRow = { ...PURCHASE, amountInr: 199 };
    const noFlag = await runVerifyTestPurchase({
      argv: [PURCHASE_ID],
      reader: reader({ purchases: [cheap] }),
    });
    expect(noFlag.exitCode).toBe(1);

    const withFlag = await runVerifyTestPurchase({
      argv: [PURCHASE_ID, '--amount', '199'],
      reader: reader({
        purchases: [cheap],
        ledger: [
          {
            ...LEDGER,
            gross: 199,
            gst: 30.36,
            gatewayFee: 4.7,
            net: 163.94,
            teacherAmount: 98.36,
            platformAmount: 65.58,
          },
        ],
      }),
    });
    expect(withFlag.checks.find((check) => check.name === 'purchase amount')?.status).toBe('PASS');
    expect(withFlag.checks.find((check) => check.name === 'ledger split')?.status).toBe('PASS');
  });

  it('answers one clear line for a silly --amount', async () => {
    const result = await runVerifyTestPurchase({
      argv: [PURCHASE_ID, '--amount', 'lots'],
      reader: reader(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].detail).toContain('rupees');
  });

  it('checks the refund with --refunded', async () => {
    const result = await runVerifyTestPurchase({
      argv: [PURCHASE_ID, '--refunded'],
      reader: reader({
        purchases: [{ ...PURCHASE, status: 'refunded' }],
        access: [],
        events: [
          CAPTURE,
          {
            eventId: 'evt_2',
            type: 'refund.processed',
            payload: { payload: { payment: { entity: { id: 'pay_RzP1', order_id: ORDER } } } },
            receivedAt: '2026-11-20T11:00:00.000Z',
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.checks.some((check) => check.name === 'refund path')).toBe(true);
  });
});

describe('runVerifyTestPurchase, missing env', () => {
  it('names both env vars, exits 1, and shows no stack trace and no key', async () => {
    const result = await runVerifyTestPurchase({
      argv: [PURCHASE_ID],
      reader: fakeGoliveReader({ configured: false }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.checks).toHaveLength(1);
    expect(result.text).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(result.text).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.text).not.toContain('    at ');
  });

  it('turns a read that threw into one FAIL line, not a crash', async () => {
    const result = await runVerifyTestPurchase({
      argv: [PURCHASE_ID],
      reader: fakeGoliveReader({ purchases: [PURCHASE], throwOn: 'ledgerRows' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.text).not.toContain('    at ');
    expect(result.checks.some((check) => check.status === 'FAIL')).toBe(true);
  });
});
