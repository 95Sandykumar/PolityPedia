/**
 * The nightly reconcile (issue 29-ledger-reconcile-payouts).
 *
 * design.md A6: "Nightly reconcile: Razorpay payments vs `purchases`,
 * mismatch -> alert." This file is the whole of that job's behaviour, with a
 * FAKE Razorpay and a FAKE store: no network call and no key anywhere in the
 * suite (web/CLAUDE.md).
 *
 * The three things that matter, in order of what would hurt most:
 *
 *  1. A payment Razorpay captured that our database knows nothing about is
 *     money taken from a student who got nothing. One alert.
 *  2. Running it twice must not double the alerts. PM2 restarts, Boss re-runs
 *     it by hand, and a cron can fire twice after a clock change. The second
 *     run writes nothing new.
 *  3. A quiet night writes nothing at all, so a non-empty alert table always
 *     means something really happened.
 */
import { describe, expect, it } from 'vitest';
import { createFakePayments, type PaymentRecord } from '@/lib/purchases/types';
import { runReconcile } from '../reconcile';
import {
  createFakeReconcileStore,
  RECONCILE_WINDOW_HOURS,
  type ReconcilePurchase,
} from '../types';

/** A fixed clock, so the 48-hour window is the same every run. */
const NOW = Date.parse('2026-11-05T20:30:00.000Z');
const HOUR_MS = 3_600_000;

function captured(paymentId: string, orderId: string | null, amountPaise: number): PaymentRecord {
  return { paymentId, orderId, amountPaise, status: 'captured' };
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

function run(options: {
  payments?: readonly PaymentRecord[];
  purchases?: readonly ReconcilePurchase[];
  store?: ReturnType<typeof createFakeReconcileStore>;
  paymentsConfigured?: boolean;
}) {
  const gateway = createFakePayments({
    configured: options.paymentsConfigured ?? true,
    listed: options.payments ?? [],
  });
  const store = options.store ?? createFakeReconcileStore({ purchases: options.purchases ?? [] });
  return runReconcile({ payments: gateway.payments, store, now: NOW }).then((outcome) => ({
    outcome,
    store,
    gateway,
  }));
}

describe('the window', () => {
  it('asks Razorpay for the last 48 hours only', async () => {
    const { gateway } = await run({ payments: [] });

    expect(gateway.listed).toHaveLength(1);
    const asked = gateway.listed[0];
    expect(asked.toSeconds).toBe(Math.floor(NOW / 1000));
    expect(asked.toSeconds - asked.fromSeconds).toBe(RECONCILE_WINDOW_HOURS * 3600);
  });

  it('asks our own database for the same window', async () => {
    const { store } = await run({ payments: [] });

    expect(store.listed).toHaveLength(1);
    expect(Date.parse(store.listed[0].sinceIso)).toBe(NOW - RECONCILE_WINDOW_HOURS * HOUR_MS);
  });
});

describe('a captured payment with no purchase', () => {
  it('writes exactly one alert', async () => {
    const { outcome, store } = await run({
      payments: [captured('pay_ghost', 'order_ghost', 39_900)],
      purchases: [],
    });

    expect(outcome.type).toBe('done');
    expect(outcome.fresh).toBe(1);
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]).toMatchObject({
      kind: 'no_purchase',
      subject: 'pay_ghost',
      orderId: 'order_ghost',
      actualPaise: 39_900,
      expectedPaise: null,
    });
  });

  it('still has one alert after a second run', async () => {
    const store = createFakeReconcileStore({ purchases: [] });
    const payments = [captured('pay_ghost', 'order_ghost', 39_900)];

    const first = await run({ payments, store });
    const second = await run({ payments, store });

    expect(first.outcome.fresh).toBe(1);
    // The second run SEES the mismatch again (it is still a mismatch) but
    // writes nothing: `recordAlert` answers false for a known (kind, subject).
    expect(second.outcome.alerts).toBe(1);
    expect(second.outcome.fresh).toBe(0);
    expect(store.alerts).toHaveLength(1);
  });

  it('names the payment even when Razorpay sends no order id', async () => {
    const { store } = await run({ payments: [captured('pay_loose', null, 29_900)] });

    expect(store.alerts).toEqual([
      {
        kind: 'no_purchase',
        subject: 'pay_loose',
        orderId: null,
        expectedPaise: null,
        actualPaise: 29_900,
      },
    ]);
  });
});

describe('a captured payment whose purchase never turned paid', () => {
  it('is a not_paid alert, because the set is shut and the money is gone', async () => {
    const { store } = await run({
      payments: [captured('pay_1', 'order_test_1', 39_900)],
      purchases: [purchase({ status: 'created' })],
    });

    expect(store.alerts).toEqual([
      {
        kind: 'not_paid',
        subject: 'pay_1',
        orderId: 'order_test_1',
        expectedPaise: 39_900,
        actualPaise: 39_900,
      },
    ]);
  });
});

describe('an amount that does not match', () => {
  it('is an alert even when both sides agree the purchase is paid', async () => {
    const { store } = await run({
      payments: [captured('pay_1', 'order_test_1', 9_900)],
      purchases: [purchase({ amountInr: 399 })],
    });

    expect(store.alerts).toEqual([
      {
        kind: 'amount_mismatch',
        subject: 'pay_1',
        orderId: 'order_test_1',
        expectedPaise: 39_900,
        actualPaise: 9_900,
      },
    ]);
  });
});

describe('our side of the ledger', () => {
  it('alerts on a paid purchase Razorpay never captured', async () => {
    const { store } = await run({
      payments: [],
      purchases: [purchase({ orderId: 'order_lonely' })],
    });

    expect(store.alerts).toEqual([
      {
        kind: 'no_payment',
        subject: 'order:order_lonely',
        orderId: 'order_lonely',
        expectedPaise: 39_900,
        actualPaise: null,
      },
    ]);
  });

  it('leaves the Rs 0 coupon path alone: no order, so nothing to reconcile', async () => {
    const { outcome, store } = await run({
      payments: [],
      purchases: [purchase({ orderId: null, amountInr: 0 })],
    });

    expect(outcome.alerts).toBe(0);
    expect(store.alerts).toEqual([]);
  });

  it('leaves an abandoned checkout alone: created, never paid, no money moved', async () => {
    const { store } = await run({
      payments: [],
      purchases: [purchase({ status: 'created', orderId: 'order_abandoned' })],
    });

    expect(store.alerts).toEqual([]);
  });
});

describe('a quiet night', () => {
  it('matches a paid purchase to its captured payment and says nothing', async () => {
    const { outcome, store } = await run({
      payments: [captured('pay_1', 'order_test_1', 39_900)],
      purchases: [purchase()],
    });

    expect(outcome).toMatchObject({ type: 'done', payments: 1, purchases: 1, alerts: 0, fresh: 0 });
    expect(store.alerts).toEqual([]);
  });

  it('ignores a failed payment: no money arrived, so nothing is missing', async () => {
    const { store } = await run({
      payments: [{ paymentId: 'pay_x', orderId: 'order_x', amountPaise: 39_900, status: 'failed' }],
      purchases: [],
    });

    expect(store.alerts).toEqual([]);
  });
});

describe('not configured', () => {
  it('idles instead of inventing alerts when Razorpay has no keys', async () => {
    const { outcome, store } = await run({
      paymentsConfigured: false,
      payments: [captured('pay_ghost', 'order_ghost', 39_900)],
    });

    expect(outcome.type).toBe('idle');
    expect(store.alerts).toEqual([]);
    expect(store.listed).toEqual([]);
  });

  it('idles when our own store has no keys', async () => {
    const store = createFakeReconcileStore({ configured: false });
    const { outcome } = await run({
      store,
      payments: [captured('pay_ghost', 'order_ghost', 39_900)],
    });

    expect(outcome.type).toBe('idle');
    expect(store.alerts).toEqual([]);
  });
});
