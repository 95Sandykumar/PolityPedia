/**
 * The server-side PlansClient over Supabase REST (issue 21-plans-entitlements).
 *
 * No real network call and no real key: `fetch` is injected and the env is a
 * plain object with obvious dummy values. The client carries the ADMIN's own
 * access token, so Postgres RLS (`entitlements_admin_all`) is the real gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabasePlansClient } from '../supabase-plans-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.test/',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
};

const ACCESS_TOKEN = 'admin.access.token';
const STUDENT = '22222222-2222-4222-8222-222222222222';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(replies: { status?: number; body?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift() ?? { status: 200, body: null };
    return new Response(next.body === null ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabasePlansClient({ accessToken: ACCESS_TOKEN, env, fetchImpl });
}

function headers(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('isConfigured', () => {
  it('is false with no env, so a page can say "not set up" instead of crashing', () => {
    const { fn } = fakeFetch();
    expect(client(fn, {}).isConfigured()).toBe(false);
  });

  it('is true once the url and key are there', () => {
    const { fn } = fakeFetch();
    expect(client(fn).isConfigured()).toBe(true);
  });

  it('reads the env lazily: importing and creating never touches the network', () => {
    const { fn, calls } = fakeFetch();
    client(fn, {});
    expect(calls).toHaveLength(0);
  });
});

describe('grant', () => {
  it('upserts one row with source admin and the admin bearer token', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: [] }]);
    await client(fn).grant({ userId: STUDENT, plan: 'pro', validUntil: '2026-12-05T00:00:00.000Z' });

    expect(calls).toHaveLength(1);
    // Trailing slash in the env url must not become a double slash.
    expect(calls[0].url).toBe('https://proj.supabase.test/rest/v1/entitlements');
    expect(calls[0].init.method).toBe('POST');
    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);
    expect(headers(calls[0]).apikey).toBe('test-anon-key');
    // Re-granting the same plan must move valid_until, not fail on the PK.
    expect(headers(calls[0]).prefer).toContain('resolution=merge-duplicates');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      user_id: STUDENT,
      plan: 'pro',
      valid_until: '2026-12-05T00:00:00.000Z',
      source: 'admin',
    });
  });

  it('refuses a plan that is not ai or pro before any network call', async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client(fn).grant({ userId: STUDENT, plan: 'platinum' as any, validUntil: '2026-12-05T00:00:00.000Z' }),
    ).rejects.toThrow(/plan/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a user id that is not a uuid before any network call', async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      client(fn).grant({ userId: 'not-a-uuid', plan: 'ai', validUntil: '2026-12-05T00:00:00.000Z' }),
    ).rejects.toThrow(/user/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a valid_until that is not a date', async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      client(fn).grant({ userId: STUDENT, plan: 'ai', validUntil: 'soon' }),
    ).rejects.toThrow(/date/i);
    expect(calls).toHaveLength(0);
  });

  it('throws a message with the status and no response body when RLS says no', async () => {
    const { fn } = fakeFetch([{ status: 403, body: { message: 'secret detail' } }]);
    await expect(
      client(fn).grant({ userId: STUDENT, plan: 'ai', validUntil: '2026-12-05T00:00:00.000Z' }),
    ).rejects.toThrow(/403/);
    await expect(
      client(fakeFetch([{ status: 403, body: { message: 'secret detail' } }]).fn).grant({
        userId: STUDENT,
        plan: 'ai',
        validUntil: '2026-12-05T00:00:00.000Z',
      }),
    ).rejects.not.toThrow(/secret detail/);
  });

  it('throws when Supabase is not configured', async () => {
    const { fn } = fakeFetch();
    await expect(
      client(fn, {}).grant({ userId: STUDENT, plan: 'ai', validUntil: '2026-12-05T00:00:00.000Z' }),
    ).rejects.toThrow(/not configured/i);
  });
});

describe('end', () => {
  it('deletes exactly the one (user, plan) row', async () => {
    const { fn, calls } = fakeFetch([{ status: 204 }]);
    await client(fn).end({ userId: STUDENT, plan: 'ai' });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe(
      `https://proj.supabase.test/rest/v1/entitlements?user_id=eq.${STUDENT}&plan=eq.ai`,
    );
    expect(headers(calls[0]).authorization).toBe('Bearer ' + ACCESS_TOKEN);
  });

  it('refuses a bad plan before any network call', async () => {
    const { fn, calls } = fakeFetch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(client(fn).end({ userId: STUDENT, plan: 'free' as any })).rejects.toThrow(/plan/i);
    expect(calls).toHaveLength(0);
  });
});

describe('list', () => {
  it('maps the stored rows into Entitlement objects', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: [
          { plan: 'pro', valid_until: '2026-12-05T00:00:00+00:00', source: 'razorpay' },
          { plan: 'ai', valid_until: '2026-11-01T00:00:00+00:00', source: 'admin' },
        ],
      },
    ]);
    const rows = await client(fn).list(STUDENT);

    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toContain(`user_id=eq.${STUDENT}`);
    expect(rows).toEqual([
      { plan: 'pro', validUntil: '2026-12-05T00:00:00+00:00', source: 'razorpay' },
      { plan: 'ai', validUntil: '2026-11-01T00:00:00+00:00', source: 'admin' },
    ]);
  });

  it('drops a row with a plan it does not know, instead of trusting it', async () => {
    const { fn } = fakeFetch([
      { status: 200, body: [{ plan: 'platinum', valid_until: '2026-12-05T00:00:00+00:00', source: 'admin' }] },
    ]);
    expect(await client(fn).list(STUDENT)).toEqual([]);
  });

  it('returns an empty list when the read fails, so a page never crashes', async () => {
    const { fn } = fakeFetch([{ status: 500, body: {} }]);
    expect(await client(fn).list(STUDENT)).toEqual([]);
  });
});

describe('canUse: the RPC that asks the SQL gate', () => {
  it('posts to rpc/can_use with the user id and feature', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: true }]);
    expect(await client(fn).canUse(STUDENT, 'notes')).toBe(true);

    expect(calls[0].url).toBe('https://proj.supabase.test/rest/v1/rpc/can_use');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      user_id: STUDENT,
      feature: 'notes',
    });
  });

  it('fails closed: a non-true answer, a bad status or a bad feature is false', async () => {
    expect(await client(fakeFetch([{ status: 200, body: false }]).fn).canUse(STUDENT, 'ai')).toBe(
      false,
    );
    expect(await client(fakeFetch([{ status: 500, body: {} }]).fn).canUse(STUDENT, 'ai')).toBe(false);
    expect(await client(fakeFetch([{ status: 200, body: 'yes' }]).fn).canUse(STUDENT, 'ai')).toBe(
      false,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await client(fakeFetch().fn).canUse(STUDENT, 'teleport' as any)).toBe(false);
    expect(await client(fakeFetch().fn, {}).canUse(STUDENT, 'ai')).toBe(false);
  });
});
