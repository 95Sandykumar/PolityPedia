/**
 * The webhook's `WebhookStore` over the Supabase REST API
 * (issue 27-razorpay-webhook-ledger).
 *
 * `fetch` is injected, so no test here reaches a network and no real key goes
 * anywhere (web/CLAUDE.md). What is actually being checked:
 *
 *  * the env is read LAZILY, so importing the file with no env vars is fine,
 *  * the SERVICE-ROLE key is the one that is sent, in both headers, because
 *    the four functions in 0027 are granted to that role alone,
 *  * `recordEvent` reads the function's own true/false answer and never
 *    guesses, because guessing "new" pays a teacher twice,
 *  * a non-2xx throws, so `handleRazorpayWebhook()` answers 500 and Razorpay
 *    delivers again.
 */
import { describe, expect, it } from 'vitest';
import { createSupabaseWebhookStore, readWebhookServiceEnv } from '../supabase-webhook-store';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_not_a_real_key',
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(replies: { status: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  let at = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[at++] ?? { status: 200, body: true };
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

describe('the service env', () => {
  it('needs both the url and the service-role key', () => {
    expect(readWebhookServiceEnv({})).toBeNull();
    expect(readWebhookServiceEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.co' })).toBeNull();
    expect(readWebhookServiceEnv({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toBeNull();
  });

  it('trims the trailing slash off the url', () => {
    expect(readWebhookServiceEnv(ENV)?.url).toBe('https://example.supabase.co');
  });

  it('will not fall back to the anon key', () => {
    // The anon key cannot execute any of 0027's functions, so accepting it
    // would turn every webhook into a silent 500 instead of a loud "not
    // configured".
    expect(
      readWebhookServiceEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'https://x.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      }),
    ).toBeNull();
  });
});

describe('isConfigured', () => {
  it('is false with no env, and true with it, read at call time', () => {
    const { fetchImpl } = recorder();
    expect(createSupabaseWebhookStore({ env: {}, fetchImpl }).isConfigured()).toBe(false);
    expect(createSupabaseWebhookStore({ env: ENV, fetchImpl }).isConfigured()).toBe(true);
  });
});

describe('recordEvent', () => {
  it('calls record_payment_event with the service-role key in both headers', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    const fresh = await store.recordEvent({
      eventId: 'evt_1',
      type: 'payment.captured',
      payload: { event: 'payment.captured' },
    });

    expect(fresh).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/rpc/record_payment_event');
    expect(calls[0].headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(calls[0].headers.authorization).toBe('Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(calls[0].body).toEqual({
      new_event_id: 'evt_1',
      new_type: 'payment.captured',
      new_payload: { event: 'payment.captured' },
    });
  });

  it('reads a false answer as "seen it", and never as new', async () => {
    const { fetchImpl } = recorder([{ status: 200, body: false }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    expect(await store.recordEvent({ eventId: 'evt_1', type: 'a', payload: {} })).toBe(false);
  });

  it('throws when the answer is not a boolean', async () => {
    const { fetchImpl } = recorder([{ status: 200, body: { oops: 1 } }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    // Fail CLOSED. Reading an unknown shape as `true` would hand the event on
    // to the grant with no de-dupe behind it.
    await expect(store.recordEvent({ eventId: 'evt_1', type: 'a', payload: {} })).rejects.toThrow(
      /record_payment_event/,
    );
  });

  it('throws on a non-2xx, and the message carries no response body', async () => {
    const { fetchImpl } = recorder([
      { status: 401, body: { message: 'JWT expired for user secret-looking-thing' } },
    ]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    const failed = store.recordEvent({ eventId: 'evt_1', type: 'a', payload: {} });
    await expect(failed).rejects.toThrow(/401/);
    await expect(failed).rejects.not.toThrow(/secret-looking-thing/);
  });
});

describe('grantPurchase', () => {
  it('sends the order id and the fee in rupees', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.grantPurchase({ orderId: 'order_test_1', feeInr: 9.41 });

    expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/rpc/grant_purchase');
    expect(calls[0].body).toEqual({ order_id: 'order_test_1', fee: 9.41 });
  });

  it('does not throw when the function answers false', async () => {
    // False is "already paid" or "not ours". Both are normal, and Razorpay
    // must get its 2xx rather than a retry.
    const { fetchImpl } = recorder([{ status: 200, body: false }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(store.grantPurchase({ orderId: 'order_x', feeInr: 0 })).resolves.toBeUndefined();
  });

  it('throws when the database refuses', async () => {
    const { fetchImpl } = recorder([{ status: 500, body: { message: 'deadlock' } }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(store.grantPurchase({ orderId: 'order_x', feeInr: 0 })).rejects.toThrow(/500/);
  });

  it('refuses an empty order id before it calls anything', async () => {
    const { calls, fetchImpl } = recorder();
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(store.grantPurchase({ orderId: '  ', feeInr: 0 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('refuses a fee that is not a sane number of rupees', async () => {
    const { calls, fetchImpl } = recorder();
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(store.grantPurchase({ orderId: 'order_x', feeInr: -1 })).rejects.toThrow();
    await expect(store.grantPurchase({ orderId: 'order_x', feeInr: NaN })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('throws "not configured" rather than calling with no key', async () => {
    const { calls, fetchImpl } = recorder();
    const store = createSupabaseWebhookStore({ env: {}, fetchImpl });

    await expect(store.grantPurchase({ orderId: 'order_x', feeInr: 0 })).rejects.toThrow(
      /not configured/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('refundPurchase and forgetEvent', () => {
  it('each call their own function with just an id', async () => {
    const { calls, fetchImpl } = recorder([
      { status: 200, body: true },
      { status: 200, body: true },
    ]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.refundPurchase({ orderId: 'order_back' });
    await store.forgetEvent('evt_1');

    expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/rpc/refund_purchase');
    expect(calls[0].body).toEqual({ order_id: 'order_back' });
    expect(calls[1].url).toBe('https://example.supabase.co/rest/v1/rpc/forget_payment_event');
    expect(calls[1].body).toEqual({ new_event_id: 'evt_1' });
  });
});
