/**
 * The nightly reconcile AS A JOB (issue 35-reconcile-visible).
 *
 * Issue 29 proved the comparison. This file proves the thing PM2 actually
 * reads: THE EXIT CODE.
 *
 * `stop_exit_codes: [0]` in `ecosystem.config.cjs` tells PM2 that exit 0 is
 * the night finishing. So exit 0 must mean "I compared both sides", and
 * nothing else. Before this issue a rotated Razorpay key made the job log
 * "not configured" and exit 0 for ever, and `pm2 list` showed a healthy app
 * that had checked nothing since the key changed.
 *
 * Four ways the job can fail to check, and every one of them is non-zero:
 *   1. a key is missing
 *   2. the Razorpay read threw
 *   3. the purchases read threw (the 2,000-row cap throws, see the store test)
 *   4. ...and that is it. Alerts found are the job WORKING, so they stay 0.
 *
 * A fake Razorpay and a fake store, as always: no network call and no key
 * anywhere in the suite (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { createFakePayments, type PaymentRecord } from '@/lib/purchases/types';
import { EXIT_CANNOT_CHECK, EXIT_CHECKED, runReconcileJob } from '../reconcile';
import { createFakeReconcileStore, type ReconcilePurchase } from '../types';

/** A fixed clock, so the 48-hour window is the same every run. */
const NOW = Date.parse('2026-11-05T20:30:00.000Z');

function captured(
  paymentId: string,
  orderId: string | null,
  amountPaise: number,
  extra: Partial<PaymentRecord> = {},
): PaymentRecord {
  return { paymentId, orderId, amountPaise, status: 'captured', ...extra };
}

function purchase(values: Partial<ReconcilePurchase> = {}): ReconcilePurchase {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orderId: 'order_test_1',
    amountInr: 399,
    status: 'paid',
    ...values,
  };
}

function job(options: {
  payments?: readonly PaymentRecord[];
  purchases?: readonly ReconcilePurchase[];
  paymentsConfigured?: boolean;
  storeConfigured?: boolean;
  failList?: boolean;
  failPurchases?: boolean;
  unreadable?: number;
}) {
  const gateway = createFakePayments({
    configured: options.paymentsConfigured ?? true,
    listed: options.payments ?? [],
    failList: options.failList ?? false,
  });
  const store = createFakeReconcileStore({
    configured: options.storeConfigured ?? true,
    purchases: options.purchases ?? [],
    failPurchases: options.failPurchases ?? false,
    unreadable: options.unreadable ?? 0,
  });
  return runReconcileJob({ payments: gateway.payments, store, now: NOW }).then((result) => ({
    ...result,
    store,
    gateway,
  }));
}

describe('a night it could not check exits non-zero (DoD 1)', () => {
  it('names the missing Razorpay keys and exits non-zero', async () => {
    const result = await job({ paymentsConfigured: false });

    expect(result.exitCode).toBe(EXIT_CANNOT_CHECK);
    expect(result.outcome?.type).toBe('idle');
    // By NAME, never by value: a key in a log file is a leaked key.
    expect(result.line).toContain('RAZORPAY_KEY_ID');
    expect(result.loud).toBe(true);
  });

  it('names the missing Supabase keys and exits non-zero', async () => {
    const result = await job({ storeConfigured: false });

    expect(result.exitCode).toBe(EXIT_CANNOT_CHECK);
    expect(result.line).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('reads neither side when a key is missing', async () => {
    const result = await job({
      paymentsConfigured: false,
      payments: [captured('pay_1', 'order_test_1', 39_900)],
      purchases: [purchase()],
    });

    expect(result.gateway.listed).toEqual([]);
    expect(result.store.listed).toEqual([]);
    expect(result.store.alerts).toEqual([]);
  });

  it('exits non-zero when the Razorpay read failed', async () => {
    const result = await job({ failList: true });

    expect(result.exitCode).toBe(EXIT_CANNOT_CHECK);
    expect(result.outcome).toBeNull();
    expect(result.loud).toBe(true);
    // The message only, never a key and never a response body.
    expect(result.line).not.toContain('rzp_test');
  });

  it('exits non-zero when the purchases read failed', async () => {
    const result = await job({ failPurchases: true });

    expect(result.exitCode).toBe(EXIT_CANNOT_CHECK);
    expect(result.outcome).toBeNull();
  });
});

describe('a night it did check exits 0 (DoD 1)', () => {
  it('exits 0 on a quiet night and writes nothing', async () => {
    const result = await job({});

    expect(result.exitCode).toBe(EXIT_CHECKED);
    expect(result.outcome?.type).toBe('done');
    expect(result.store.alerts).toEqual([]);
    expect(result.loud).toBe(false);
  });

  it('exits 0 WITH alerts: an alert is the job working', async () => {
    const result = await job({ payments: [captured('pay_ghost', 'order_ghost', 39_900)] });

    expect(result.exitCode).toBe(EXIT_CHECKED);
    expect(result.store.alerts).toHaveLength(1);
    // A NEW mismatch is loud in `pm2 logs`, and still a finished night.
    expect(result.loud).toBe(true);
  });
});

describe('purchase rows it could not read (DoD 2)', () => {
  /** One sale that lines up perfectly, so the only alert can be the new one. */
  const CLEAN = {
    payments: [captured('pay_1', 'order_test_1', 39_900)],
    purchases: [purchase({ orderId: 'order_test_1', amountInr: 399, status: 'paid' as const })],
  };

  it('files one alert when the store dropped rows', async () => {
    const result = await job({ ...CLEAN, unreadable: 3 });

    expect(result.store.alerts).toHaveLength(1);
    expect(result.store.alerts[0].kind).toBe('unreadable_purchase');
    // No amount on either side: the problem is a COUNT, not a mismatch.
    expect(result.store.alerts[0].expectedPaise).toBeNull();
    expect(result.store.alerts[0].actualPaise).toBeNull();
    expect(result.outcome?.unreadable).toBe(3);
  });

  it('names the window start, so one strange night is one line', async () => {
    const result = await job({ ...CLEAN, unreadable: 1 });

    expect(result.store.alerts[0].subject).toBe('purchases:' + result.store.listed[0].sinceIso);
  });

  it('files nothing when every row read cleanly', async () => {
    const result = await job({ ...CLEAN, unreadable: 0 });

    expect(result.store.alerts).toEqual([]);
    expect(result.outcome?.unreadable).toBe(0);
  });
});

describe('subscription charges are not sales (DoD 3)', () => {
  it('does not file no_purchase for a payment with an invoice id', async () => {
    const result = await job({
      payments: [captured('pay_sub_1', 'order_rzp_own_1', 10_000, { invoiceId: 'inv_1' })],
    });

    expect(result.store.alerts).toEqual([]);
    expect(result.exitCode).toBe(EXIT_CHECKED);
  });

  it('does not file no_purchase for a payment linked to a subscription', async () => {
    const result = await job({
      payments: [captured('pay_sub_2', 'order_rzp_own_2', 50_000, { subscriptionId: 'sub_1' })],
    });

    expect(result.store.alerts).toEqual([]);
  });

  it('still files no_purchase for a one-off payment with no row of ours', async () => {
    const result = await job({ payments: [captured('pay_ghost', 'order_ghost', 39_900)] });

    expect(result.store.alerts).toHaveLength(1);
    expect(result.store.alerts[0].kind).toBe('no_purchase');
    expect(result.store.alerts[0].subject).toBe('pay_ghost');
  });

  it('never lets a subscription charge hide one of our unpaid orders', async () => {
    // The subscription payment carries an order id that happens to be ours.
    // It must NOT count as the capture for that order.
    const result = await job({
      payments: [captured('pay_sub_3', 'order_test_1', 10_000, { invoiceId: 'inv_3' })],
      purchases: [purchase({ orderId: 'order_test_1', status: 'paid' })],
    });

    expect(result.store.alerts).toHaveLength(1);
    expect(result.store.alerts[0].kind).toBe('no_payment');
  });
});
