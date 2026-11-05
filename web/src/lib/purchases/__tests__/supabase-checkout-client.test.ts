/**
 * The server-side `CheckoutClient` (issue 26-razorpay-order-checkout).
 *
 * `fetch` is injected, so there is no network call and no real key in this
 * file (web/CLAUDE.md). What is checked:
 *
 *  * the call carries the STUDENT'S OWN access token, and sends NO amount
 *    (F-G2: there is nothing in the request for a price to hide in),
 *  * a SQLSTATE becomes our own code, so the UI can say "already unlocked",
 *  * a PostgREST message never escapes: the thrown error carries our code
 *    only,
 *  * a reply we cannot read fails CLOSED, never as a free set.
 */
import { describe, expect, it } from 'vitest';
import { createSupabaseCheckoutClient } from '../supabase-checkout-client';
import { PurchaseError } from '../types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const SET = '22222222-2222-4222-8222-222222222222';
const PURCHASE = '55555555-5555-4555-8555-555555555555';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recorder(reply: unknown, ok = true, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      async json() {
        return reply;
      },
      async text() {
        return reply === undefined ? '' : JSON.stringify(reply);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseCheckoutClient({ accessToken: 'student-token', env, fetchImpl });
}

describe('configuration', () => {
  it('is not configured with no environment variables', () => {
    const { fetchImpl } = recorder([]);
    expect(client(fetchImpl, {}).isConfigured()).toBe(false);
  });
});

describe('start', () => {
  it('calls start_set_purchase with the set and coupon only', async () => {
    const { calls, fetchImpl } = recorder([
      { purchase_id: PURCHASE, amount_inr: 399, status: 'created' },
    ]);

    const started = await client(fetchImpl).start({ setId: SET, coupon: 'FREE100' });

    expect(started).toEqual({ purchaseId: PURCHASE, amountInr: 399, status: 'created' });
    expect(calls[0].url).toBe('https://project.supabase.co/rest/v1/rpc/start_set_purchase');

    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    // F-G2: two keys, and neither is an amount.
    expect(Object.keys(sent).sort()).toEqual(['coupon_code', 'for_set']);
    expect(sent).toEqual({ for_set: SET, coupon_code: 'FREE100' });

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer student-token');
  });

  it('sends null when there is no coupon', async () => {
    const { calls, fetchImpl } = recorder([
      { purchase_id: PURCHASE, amount_inr: 399, status: 'created' },
    ]);
    await client(fetchImpl).start({ setId: SET });
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(sent.coupon_code).toBeNull();
  });

  it('reads the Rs 0 answer as paid', async () => {
    const { fetchImpl } = recorder([{ purchase_id: PURCHASE, amount_inr: 0, status: 'paid' }]);
    await expect(client(fetchImpl).start({ setId: SET, coupon: 'FREE100' })).resolves.toEqual({
      purchaseId: PURCHASE,
      amountInr: 0,
      status: 'paid',
    });
  });

  it('turns each SQLSTATE into our own code', async () => {
    const cases: [string, string][] = [
      ['PP401', 'sign_in'],
      ['PP403', 'own_set'],
      ['PP404', 'not_found'],
      ['PP409', 'owned'],
      ['PP422', 'coupon'],
      ['42501', 'failed'],
    ];

    for (const [sqlstate, code] of cases) {
      const { fetchImpl } = recorder(
        { code: sqlstate, message: 'policy "purchases_select_own" says no' },
        false,
        400,
      );
      await expect(client(fetchImpl).start({ setId: SET })).rejects.toMatchObject({ code });
    }
  });

  it('never lets a Postgres message out', async () => {
    const { fetchImpl } = recorder(
      { code: 'PP409', message: 'constraint "purchases_paid_check" was violated' },
      false,
      409,
    );

    await expect(client(fetchImpl).start({ setId: SET })).rejects.toThrow(
      /^purchase refused: owned$/,
    );
  });

  it('fails closed on a reply it cannot read', async () => {
    for (const reply of [[], null, [{ purchase_id: 'nope', amount_inr: 0, status: 'paid' }], {}]) {
      const { fetchImpl } = recorder(reply);
      await expect(client(fetchImpl).start({ setId: SET })).rejects.toBeInstanceOf(PurchaseError);
    }
  });

  it('refuses a set id that is not a uuid without calling out', async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(client(fetchImpl).start({ setId: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('attachOrderId', () => {
  it('calls attach_order_id with the purchase and the order', async () => {
    const { calls, fetchImpl } = recorder(undefined);

    await client(fetchImpl).attachOrderId(PURCHASE, 'order_test_1');

    expect(calls[0].url).toBe('https://project.supabase.co/rest/v1/rpc/attach_order_id');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      purchase: PURCHASE,
      order_id: 'order_test_1',
    });
  });

  it('throws our code when Postgres refuses the write', async () => {
    const { fetchImpl } = recorder({ code: 'PP404' }, false, 404);
    await expect(client(fetchImpl).attachOrderId(PURCHASE, 'order_1')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
