/**
 * The server-side `SetAccessClient` over Supabase REST
 * (issue 16-set-access-mock-list).
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md). What is asserted is the shape of the
 * request, because that shape is what RLS sees:
 *
 *  * every call carries the CALLER'S OWN access token, never a service key,
 *  * a grant always says `source: 'admin'`, whatever the caller asked for,
 *  * a read never asks for `select=*`,
 *  * a missing env gives an empty list, not a crash.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseSetAccessClient } from '../supabase-set-access-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const USER = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const TEST_1 = '44444444-4444-4444-8444-444444444444';
const TEST_2 = '55555555-5555-4555-8555-555555555555';

const SOON = '2026-12-05T10:00:00.000Z';

function jsonOnce(body: unknown, status = 200) {
  // A 204 may not carry a body at all, which is exactly what PostgREST sends
  // back for `return=minimal`.
  return vi.fn(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
  );
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseSetAccessClient({
    accessToken: 'caller.token',
    userId: USER,
    env,
    fetchImpl,
  });
}

/** The URL and the init of call number `index`. */
function callAt(fetchImpl: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: (init.headers ?? {}) as Record<string, string> };
}

describe('isConfigured', () => {
  it('is false with no env, so the page can say so', () => {
    expect(client(jsonOnce([]) as unknown as typeof fetch, {}).isConfigured()).toBe(false);
  });

  it('is true once both vars are set', () => {
    expect(client(jsonOnce([]) as unknown as typeof fetch).isConfigured()).toBe(true);
  });
});

describe('listMine', () => {
  it('asks for the caller own rows with the caller own token', async () => {
    const fetchImpl = jsonOnce([
      { set_id: SET, source: 'admin', valid_until: SOON },
    ]);
    const rows = await client(fetchImpl as unknown as typeof fetch).listMine();

    expect(rows).toEqual([{ setId: SET, source: 'admin', validUntil: SOON }]);

    const { url, headers } = callAt(fetchImpl);
    expect(url).toContain('/rest/v1/set_access?select=set_id,source,valid_until');
    expect(url).toContain(`user_id=eq.${USER}`);
    expect(url).not.toContain('select=*');
    expect(headers.authorization).toBe('Bearer caller.token');
  });

  it('drops a row whose source is not one we know', async () => {
    const fetchImpl = jsonOnce([
      { set_id: SET, source: 'gift', valid_until: SOON },
      { set_id: SET, source: 'purchase', valid_until: 'infinity' },
    ]);
    const rows = await client(fetchImpl as unknown as typeof fetch).listMine();
    expect(rows).toEqual([{ setId: SET, source: 'purchase', validUntil: 'infinity' }]);
  });

  it('is empty with no env, and never calls fetch', async () => {
    const fetchImpl = jsonOnce([]);
    expect(await client(fetchImpl as unknown as typeof fetch, {}).listMine()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is empty when Supabase answers 500', async () => {
    const fetchImpl = jsonOnce({ message: 'boom' }, 500);
    expect(await client(fetchImpl as unknown as typeof fetch).listMine()).toEqual([]);
  });
});

describe('listScores', () => {
  it('asks only for submitted sittings of the given tests', async () => {
    const fetchImpl = jsonOnce([
      { test_id: TEST_1, score: 64, submitted_at: '2026-11-04T10:00:00.000Z' },
    ]);
    const rows = await client(fetchImpl as unknown as typeof fetch).listScores([
      TEST_1,
      TEST_2,
    ]);

    expect(rows).toEqual([{ testId: TEST_1, score: 64 }]);

    const { url } = callAt(fetchImpl);
    expect(url).toContain(`user_id=eq.${USER}`);
    expect(url).toContain(`test_id=in.(${TEST_1},${TEST_2})`);
    expect(url).toContain('submitted_at=not.is.null');
    expect(url).toContain('order=submitted_at.desc');
  });

  it('keeps the NEWEST sitting per test and drops the older one', async () => {
    const fetchImpl = jsonOnce([
      { test_id: TEST_1, score: 70, submitted_at: '2026-11-04T10:00:00.000Z' },
      { test_id: TEST_1, score: 20, submitted_at: '2026-10-01T10:00:00.000Z' },
    ]);
    const rows = await client(fetchImpl as unknown as typeof fetch).listScores([TEST_1]);
    expect(rows).toEqual([{ testId: TEST_1, score: 70 }]);
  });

  it('keeps a sitting with no score as taken-but-unscored', async () => {
    const fetchImpl = jsonOnce([
      { test_id: TEST_1, score: null, submitted_at: '2026-11-04T10:00:00.000Z' },
    ]);
    const rows = await client(fetchImpl as unknown as typeof fetch).listScores([TEST_1]);
    expect(rows).toEqual([{ testId: TEST_1, score: null }]);
  });

  it('asks nothing when there is no test to ask about', async () => {
    const fetchImpl = jsonOnce([]);
    expect(await client(fetchImpl as unknown as typeof fetch).listScores([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops an id that is not a uuid before it reaches a URL', async () => {
    const fetchImpl = jsonOnce([]);
    await client(fetchImpl as unknown as typeof fetch).listScores(['../../etc/passwd']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('grant', () => {
  it('always stores source admin, upserting on the primary key', async () => {
    const fetchImpl = jsonOnce(null, 201);
    await client(fetchImpl as unknown as typeof fetch).grant({
      userId: STUDENT,
      setId: SET,
      validUntil: SOON,
    });

    const { url, init, headers } = callAt(fetchImpl);
    expect(url).toBe('https://project.supabase.co/rest/v1/set_access');
    expect(init.method).toBe('POST');
    expect(headers.prefer).toContain('resolution=merge-duplicates');
    expect(JSON.parse(String(init.body))).toEqual({
      user_id: STUDENT,
      set_id: SET,
      source: 'admin',
      valid_until: SOON,
    });
  });

  it('refuses an id that is not a uuid before any request', async () => {
    const fetchImpl = jsonOnce(null, 201);
    const api = client(fetchImpl as unknown as typeof fetch);

    await expect(
      api.grant({ userId: 'me', setId: SET, validUntil: SOON }),
    ).rejects.toThrow();
    await expect(
      api.grant({ userId: STUDENT, setId: 'that one', validUntil: SOON }),
    ).rejects.toThrow();
    await expect(
      api.grant({ userId: STUDENT, setId: SET, validUntil: 'soon' }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws the status and never the body when Postgres refuses', async () => {
    const fetchImpl = jsonOnce(
      { message: 'new row violates row-level security policy for table "set_access"' },
      401,
    );
    await expect(
      client(fetchImpl as unknown as typeof fetch).grant({
        userId: STUDENT,
        setId: SET,
        validUntil: SOON,
      }),
    ).rejects.toThrow('Supabase set access grant failed with status 401');
  });
});

describe('revoke', () => {
  it('deletes only the hand-granted row for that student and set', async () => {
    const fetchImpl = jsonOnce(null, 204);
    await client(fetchImpl as unknown as typeof fetch).revoke({
      userId: STUDENT,
      setId: SET,
    });

    const { url, init } = callAt(fetchImpl);
    expect(init.method).toBe('DELETE');
    expect(url).toContain(`user_id=eq.${STUDENT}`);
    expect(url).toContain(`set_id=eq.${SET}`);
    // A purchase is not an admin's to undo from this screen.
    expect(url).toContain('source=eq.admin');
  });

  it('refuses a missing set id, so one call cannot clear every set', async () => {
    const fetchImpl = jsonOnce(null, 204);
    await expect(
      client(fetchImpl as unknown as typeof fetch).revoke({ userId: STUDENT, setId: '' }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
