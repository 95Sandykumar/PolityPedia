/**
 * The reconcile store's two silent failures, closed (issue 35-reconcile-visible).
 *
 * `fetch` is INJECTED, so there is no network call and no key in this file
 * (web/CLAUDE.md).
 *
 * 1. THE CAP. The purchases read asks for 2,000 rows and its own comment said
 *    that reaching the cap is an error, and then returned the truncated list
 *    anyway. A truncated list of our own sales turns every sale the job did
 *    not see into a `no_payment` alert: Boss would wake up to hundreds of
 *    alerts about real, correct sales. Reaching the cap now THROWS, which the
 *    job reports as a night it could not check.
 *
 * 2. DROPPED ROWS. A row whose shape we cannot read is still dropped, which is
 *    right (a guessed `paid` hides a real mismatch), but it used to be dropped
 *    SILENTLY. They are counted now, and the job files one alert for the count.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PURCHASES, createSupabaseReconcileStore } from '../supabase-reconcile-store';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
};

const SINCE = '2026-11-03T20:30:00.000Z';

/** One readable purchase row, as PostgREST sends it. */
function row(index: number) {
  return {
    id: '11111111-1111-4111-8111-' + String(index).padStart(12, '0'),
    razorpay_order_id: 'order_test_' + index,
    amount_inr: 399,
    status: 'paid',
  };
}

function storeOf(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    calls.push(String(input));
    return {
      ok,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { store: createSupabaseReconcileStore({ env: ENV, fetchImpl }), calls };
}

describe('the 2,000-row cap (DoD 2)', () => {
  it('throws when the result length equals the cap', async () => {
    const rows = Array.from({ length: MAX_PURCHASES }, (_, index) => row(index));
    const { store } = storeOf(rows);

    await expect(store.listPurchases({ sinceIso: SINCE })).rejects.toThrow(/cap/i);
  });

  it('answers normally one row below the cap', async () => {
    const rows = Array.from({ length: MAX_PURCHASES - 1 }, (_, index) => row(index));
    const { store } = storeOf(rows);

    const page = await store.listPurchases({ sinceIso: SINCE });
    expect(page.purchases).toHaveLength(MAX_PURCHASES - 1);
    expect(page.unreadable).toBe(0);
  });

  it('counts the cap on the RAW rows, not the readable ones', async () => {
    // Every row is junk, so a cap check that counted parsed rows would see 0
    // and report a quiet night over a truncated read.
    const rows = Array.from({ length: MAX_PURCHASES }, () => ({ id: 7 }));
    const { store } = storeOf(rows);

    await expect(store.listPurchases({ sinceIso: SINCE })).rejects.toThrow(/cap/i);
  });
});

describe('rows it could not read (DoD 2)', () => {
  it('counts them instead of dropping them silently', async () => {
    const { store } = storeOf([row(1), { id: 'x' }, { amount_inr: 'free' }, row(2)]);

    const page = await store.listPurchases({ sinceIso: SINCE });
    expect(page.purchases).toHaveLength(2);
    expect(page.unreadable).toBe(2);
  });

  it('counts nothing when every row is readable', async () => {
    const { store } = storeOf([row(1), row(2)]);

    const page = await store.listPurchases({ sinceIso: SINCE });
    expect(page.unreadable).toBe(0);
  });

  it('reads a body that is not an array as zero rows and zero unreadable', async () => {
    const { store } = storeOf({ message: 'nope' });

    const page = await store.listPurchases({ sinceIso: SINCE });
    expect(page.purchases).toEqual([]);
    expect(page.unreadable).toBe(0);
  });
});

describe('a failed read', () => {
  it('throws with the status and never the body', async () => {
    const { store } = storeOf({ hint: 'policy "x" blocks it' }, false, 503);

    await expect(store.listPurchases({ sinceIso: SINCE })).rejects.toThrow('503');
    await expect(store.listPurchases({ sinceIso: SINCE })).rejects.not.toThrow(/policy/);
  });
});
