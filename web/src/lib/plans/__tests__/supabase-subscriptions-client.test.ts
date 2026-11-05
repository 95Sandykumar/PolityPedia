/**
 * The server-side `SubscriptionsClient` over Supabase REST
 * (issue 28-plan-subscriptions).
 *
 * `fetch` is injected, so no test here reaches a network and no real key or
 * token goes anywhere (web/CLAUDE.md). What is actually being checked:
 *
 *  * the env is read LAZILY, so importing the file with no env vars is fine,
 *  * the STUDENT'S OWN access token is what travels, not a service-role key:
 *    `start_plan_subscription()` takes its buyer from `auth.uid()`, so the
 *    token IS the identity,
 *  * a reply we cannot read fails CLOSED, because reading a broken reply as
 *    "started" sends a student to pay against a row id we invented,
 *  * a refusal becomes OUR code from the SQLSTATE and never the PostgREST
 *    message, which quotes constraint and policy names.
 */
import { describe, expect, it } from 'vitest';
import { PurchaseError } from '@/lib/purchases/types';
import { createSupabaseSubscriptionsClient } from '../supabase-subscriptions-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon_not_a_real_key',
};

const TOKEN = 'student_not_a_real_token';
const ROW = '11111111-1111-4111-8111-111111111111';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(replies: { status: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  let at = 0;

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const reply = replies[at++] ?? { status: 200, body: [] };
    calls.push({
      url: String(input),
      method: init?.method,
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

function client(
  replies: { status: number; body?: unknown }[] = [],
  env: Record<string, string | undefined> = ENV,
) {
  const { calls, fetchImpl } = recorder(replies);
  return { calls, client: createSupabaseSubscriptionsClient({ accessToken: TOKEN, env, fetchImpl }) };
}

describe('configuration', () => {
  it('is not configured with no environment variables', () => {
    expect(client([], {}).client.isConfigured()).toBe(false);
  });
});

describe('start', () => {
  it('sends the plan and nothing else, with the student’s own token', async () => {
    const { calls, client: c } = client([
      { status: 200, body: [{ subscription_id: ROW, amount_inr: 500, status: 'created' }] },
    ]);

    await expect(c.start('pro')).resolves.toEqual({
      subscriptionId: ROW,
      amountInr: 500,
      status: 'created',
    });

    expect(calls[0].url).toBe(
      'https://example.supabase.co/rest/v1/rpc/start_plan_subscription',
    );
    // F-G2: a plan name, and no amount anywhere in the body.
    expect(calls[0].body).toEqual({ for_plan: 'pro' });
    expect(calls[0].headers.authorization).toBe('Bearer ' + TOKEN);
    // There is no service-role key in this file at all.
    expect(JSON.stringify(calls[0].headers)).not.toMatch(/service_role/);
  });

  it('refuses a plan we do not sell before any call', async () => {
    const { calls, client: c } = client();
    await expect(c.start('platinum' as never)).rejects.toBeInstanceOf(PurchaseError);
    expect(calls).toHaveLength(0);
  });

  it('turns the SQLSTATE into our own code and drops the message', async () => {
    const { client: c } = client([
      { status: 409, body: { code: 'PP409', message: 'you already have that plan' } },
    ]);

    await expect(c.start('ai')).rejects.toMatchObject({ code: 'owned' });
  });

  it('fails CLOSED on a reply it cannot read', async () => {
    for (const body of [
      [],
      null,
      [{ subscription_id: 'not-a-uuid', amount_inr: 100, status: 'created' }],
      // Rs 0 would be a free Pro plan. 0028 refuses to store one; so does this.
      [{ subscription_id: ROW, amount_inr: 0, status: 'created' }],
      [{ subscription_id: ROW, amount_inr: 100, status: 'refunded' }],
    ]) {
      const { client: c } = client([{ status: 200, body }]);
      await expect(c.start('ai')).rejects.toMatchObject({ code: 'failed' });
    }
  });
});

describe('attachSubscriptionId', () => {
  it('sends both ids, trimmed', async () => {
    const { calls, client: c } = client([{ status: 200, body: true }]);
    await c.attachSubscriptionId(ROW, ' sub_test_1 ');

    expect(calls[0].url).toBe(
      'https://example.supabase.co/rest/v1/rpc/attach_subscription_id',
    );
    expect(calls[0].body).toEqual({ subscription: ROW, subscription_id: 'sub_test_1' });
  });

  it('refuses a bad row id or a bad gateway id before any call', async () => {
    const { calls, client: c } = client();
    await expect(c.attachSubscriptionId('nope', 'sub_test_1')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(c.attachSubscriptionId(ROW, '   ')).rejects.toMatchObject({ code: 'failed' });
    await expect(c.attachSubscriptionId(ROW, 'x'.repeat(81))).rejects.toMatchObject({
      code: 'failed',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('list', () => {
  it('asks for two columns and relies on RLS for the filter', async () => {
    const { calls, client: c } = client([
      {
        status: 200,
        body: [
          { plan: 'pro', status: 'cancelled' },
          { plan: 'ai', status: 'active' },
        ],
      },
    ]);

    await expect(c.list()).resolves.toEqual([
      { plan: 'pro', status: 'cancelled' },
      { plan: 'ai', status: 'active' },
    ]);

    // No `user_id=eq.` in the query: `subscriptions_select_own` is the filter,
    // so there is no filter here that a bug could widen.
    expect(calls[0].url).toContain('select=plan,status');
    expect(calls[0].url).not.toContain('user_id');
    expect(calls[0].method).toBe('GET');
  });

  it('drops a row it cannot read rather than guessing a status', async () => {
    const { client: c } = client([
      {
        status: 200,
        body: [
          { plan: 'platinum', status: 'active' },
          { plan: 'ai', status: 'whatever' },
          { plan: 'ai', status: 'active' },
        ],
      },
    ]);
    // An invented 'active' would make a card claim a plan nobody paid for.
    await expect(c.list()).resolves.toEqual([{ plan: 'ai', status: 'active' }]);
  });

  it('answers an empty list on any failure, and never throws', async () => {
    for (const reply of [{ status: 500 }, { status: 200, body: { oops: true } }]) {
      const { client: c } = client([reply]);
      await expect(c.list()).resolves.toEqual([]);
    }
    await expect(client([], {}).client.list()).resolves.toEqual([]);
  });
});
