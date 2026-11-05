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
import { WebhookPermanentError } from '../webhook';

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

describe('chargeSubscription and markSubscription (issue 28-plan-subscriptions)', () => {
  it('call 0028’s functions with the Razorpay subscription id', async () => {
    const { calls, fetchImpl } = recorder([
      { status: 200, body: true },
      { status: 200, body: true },
    ]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.chargeSubscription({ subscriptionId: ' sub_test_1 ' });
    await store.markSubscription({ subscriptionId: 'sub_test_1', status: 'cancelled' });

    expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/rpc/charge_subscription');
    // Trimmed, because 0028's CHECK refuses a padded id.
    expect(calls[0].body).toEqual({ subscription_id: 'sub_test_1' });
    expect(calls[1].url).toBe('https://example.supabase.co/rest/v1/rpc/mark_subscription');
    expect(calls[1].body).toEqual({ subscription_id: 'sub_test_1', new_status: 'cancelled' });

    // The SERVICE-ROLE key, in both headers: 0028 revokes both functions from
    // `authenticated`, so the anon key cannot run them.
    expect(calls[0].headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(calls[0].headers.authorization).toBe('Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('throws on a non-2xx, so the webhook answers 500 and Razorpay retries', async () => {
    const { fetchImpl } = recorder([{ status: 500, body: { message: 'boom' } }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    // The status and nothing else: a PostgREST body quotes constraint names.
    await expect(store.chargeSubscription({ subscriptionId: 'sub_test_1' })).rejects.toThrow(
      /charge_subscription failed with status 500/,
    );
  });

  it('refuses an empty or over-long subscription id before any call', async () => {
    const { calls, fetchImpl } = recorder();
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(store.chargeSubscription({ subscriptionId: '  ' })).rejects.toThrow(
      /subscription id/,
    );
    await expect(
      store.markSubscription({ subscriptionId: 'x'.repeat(81), status: 'active' }),
    ).rejects.toThrow(/subscription id/);
    expect(calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Issue 34-webhook-grant-first
// --------------------------------------------------------------------------

describe('the amount and the currency (issue 34-webhook-grant-first)', () => {
  it('sends what the signed body said was paid', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.grantPurchase({
      orderId: 'order_1',
      feeInr: 9.41,
      amountPaise: 39_900,
      currency: 'inr',
    });

    expect(calls[0].body).toEqual({
      order_id: 'order_1',
      fee: 9.41,
      paid_paise: 39_900,
      // Upper case, because 0034 compares against 'INR'.
      paid_currency: 'INR',
    });
  });

  it('leaves both OUT when the gateway did not say', async () => {
    // Omitted and not null, so 0034's own defaults decide and the call looks
    // exactly like the old two-argument one: "nothing to check".
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.grantPurchase({ orderId: 'order_2', feeInr: 0, amountPaise: null, currency: null });

    expect(calls[0].body).toEqual({ order_id: 'order_2', fee: 0 });
  });
});

describe('the charge key and the plan (issue 34-webhook-grant-first)', () => {
  it('sends the de-dupe key, the type and the body in the SAME call', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.chargeSubscription({
      subscriptionId: 'sub_test_1',
      chargeKey: 'charged:pay_m1',
      type: 'subscription.charged',
      payload: { event: 'subscription.charged' },
    });

    // ONE request. The de-dupe row and the month are one transaction, so
    // there is no `record_payment_event` call in front of it.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/rpc/charge_subscription');
    expect(calls[0].body).toEqual({
      subscription_id: 'sub_test_1',
      charge_key: 'charged:pay_m1',
      new_type: 'subscription.charged',
      new_payload: { event: 'subscription.charged' },
    });
  });

  it('maps the Razorpay plan id to our own plan word', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({
      env: { ...ENV, RAZORPAY_PLAN_AI_ID: 'plan_ai_x', RAZORPAY_PLAN_PRO_ID: 'plan_pro_x' },
      fetchImpl,
    });

    await store.chargeSubscription({ subscriptionId: 'sub_1', planId: 'plan_pro_x' });

    expect((calls[0].body as { charged_plan?: string }).charged_plan).toBe('pro');
  });

  it('sends a word that matches neither plan when the id is unknown', async () => {
    // Guessing is how a Rs 500 Pro row gets extended by a Rs 100 AI charge.
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({
      env: { ...ENV, RAZORPAY_PLAN_AI_ID: 'plan_ai_x' },
      fetchImpl,
    });

    await store.chargeSubscription({ subscriptionId: 'sub_1', planId: 'plan_somebody_else' });

    const sent = (calls[0].body as { charged_plan?: string }).charged_plan;
    expect(sent).toBeDefined();
    expect(['ai', 'pro']).not.toContain(sent);
  });

  it('sends no plan at all when no plan variable is set', async () => {
    // A fresh install sets the keys before the plan objects, and a charge that
    // really arrives must not be refused for that.
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.chargeSubscription({ subscriptionId: 'sub_1', planId: 'plan_ai_x' });

    expect(calls[0].body).toEqual({ subscription_id: 'sub_1' });
  });
});

describe('recordAlert (issue 34-webhook-grant-first)', () => {
  it('calls 0029’s own writer with the five arguments', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.recordAlert({
      kind: 'bad_event',
      subject: 'event:evt_1',
      orderId: 'order_1',
      expectedPaise: 39_900,
      actualPaise: 100,
    });

    expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/rpc/record_reconcile_alert');
    expect(calls[0].body).toEqual({
      new_kind: 'bad_event',
      new_subject: 'event:evt_1',
      new_order_id: 'order_1',
      new_expected_paise: 39_900,
      new_actual_paise: 100,
    });
    // The SERVICE-ROLE key: 0029 revokes the writer from `authenticated`.
    expect(calls[0].headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('trims a long subject to the 160 characters 0029 allows', async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: true }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await store.recordAlert({
      kind: 'bad_event',
      subject: 'event:' + 'x'.repeat(400),
      orderId: null,
      expectedPaise: null,
      actualPaise: null,
    });

    expect((calls[0].body as { new_subject: string }).new_subject).toHaveLength(160);
  });
});

describe('an event that can never succeed (issue 34-webhook-grant-first)', () => {
  it('throws a PERMANENT error for an over-long order id', async () => {
    // A plain Error is a 500 and hours of Razorpay retries. An 81-character
    // order id will still be 81 characters next time, so the handler has to be
    // able to tell the two apart.
    const { calls, fetchImpl } = recorder();
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(
      store.grantPurchase({ orderId: 'order_' + 'x'.repeat(75), feeInr: 0 }),
    ).rejects.toBeInstanceOf(WebhookPermanentError);
    expect(calls).toHaveLength(0);
  });

  it('throws a PERMANENT error for a fee that is not a fee', async () => {
    const { calls, fetchImpl } = recorder();
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    await expect(
      store.grantPurchase({ orderId: 'order_1', feeInr: 400_000 }),
    ).rejects.toBeInstanceOf(WebhookPermanentError);
    expect(calls).toHaveLength(0);
  });

  it('throws a PLAIN error when the database is merely unwell', async () => {
    // Opposite answer, so this one MUST get its retry.
    const { fetchImpl } = recorder([{ status: 500, body: { message: 'deadlock' } }]);
    const store = createSupabaseWebhookStore({ env: ENV, fetchImpl });

    const failed = store.grantPurchase({ orderId: 'order_1', feeInr: 0 });
    await expect(failed).rejects.toThrow(/500/);
    await expect(failed).rejects.not.toBeInstanceOf(WebhookPermanentError);
  });
});
