/**
 * The server-side `MockSetsClient` over the Supabase REST API
 * (issue 15-mock-sets-authoring).
 *
 * `fetch` is injected, so no request leaves the machine and no real key is
 * anywhere in this file (web/CLAUDE.md).
 *
 * The rules pinned here:
 *
 *  * no env -> `isConfigured()` is false and NOT ONE request is fired.
 *  * every call carries the CALLER'S own access token, never a service key.
 *  * an insert sets `teacher_id` from the SESSION and never a `status`.
 *  * a 409 becomes a NAMED error, so the route answers 409 without reading a
 *    Postgres message.
 *  * `publish_mock_set()`'s error CODES become the names the route switches on.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseMocksClient } from '../supabase-mocks-client';
import type { MockSetEdit } from '../types';

const EXAM = 'a4000001-0000-4000-8000-000000000001';
const SET = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mocks(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseMocksClient({
    accessToken: 'caller-token',
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

function setRow(over: Record<string, unknown> = {}) {
  return {
    id: SET,
    teacher_id: TEACHER,
    exam_id: EXAM,
    title: 'Full length set 1',
    price_inr: 349,
    status: 'draft',
    ...over,
  };
}

function testRow(over: Record<string, unknown> = {}) {
  return {
    id: TEST,
    set_id: SET,
    title: 'Test 1',
    position: 1,
    duration_min: 120,
    is_free_sample: true,
    ...over,
  };
}

const EDIT: MockSetEdit = {
  id: null,
  examId: EXAM,
  title: 'Full length set 1',
  priceInr: 349,
};

describe('createSupabaseMocksClient', () => {
  it('reports not configured with no env, and never fires a request', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = mocks(fetchImpl as unknown as typeof fetch, {});

    expect(client.isConfigured()).toBe(false);
    expect(await client.listMine()).toEqual([]);
    expect(await client.listTests(SET)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the caller own sets with the caller own token', async () => {
    const fetchImpl = vi.fn(async () => json([setRow()]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    const rows = await client.listMine();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/mock_sets');
    expect(url).toContain(`teacher_id=eq.${TEACHER}`);
    expect(url).not.toContain('select=*');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer caller-token');

    expect(rows).toEqual([
      {
        id: SET,
        teacherId: TEACHER,
        examId: EXAM,
        title: 'Full length set 1',
        priceInr: 349,
        status: 'draft',
      },
    ]);
  });

  it('asks for status=live as well as the policy, for a student read', async () => {
    const fetchImpl = vi.fn(async () => json([setRow({ status: 'live' })]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await client.listLiveForTeacher(TEACHER);

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('status=eq.live');
  });

  it('drops a set whose price or status it does not recognise', async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        setRow({ status: 'published' }),
        setRow({ id: TEST, price_inr: 'free' }),
        setRow({ id: EXAM }),
      ]),
    );
    const client = mocks(fetchImpl as unknown as typeof fetch);
    const rows = await client.listMine();
    expect(rows.map((one) => one.id)).toEqual([EXAM]);
  });

  it('gives an empty list, never a crash, when Supabase says no', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'nope' }, 500));
    const client = mocks(fetchImpl as unknown as typeof fetch);
    expect(await client.listMine()).toEqual([]);
    expect(await client.listTests(SET)).toEqual([]);
    expect(await client.readOne(SET)).toBeNull();
  });

  it('refuses a set id that is not a uuid, before building a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    expect(await client.readOne('set-1')).toBeNull();
    expect(await client.listTests('set-1')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the tests of one set in position order', async () => {
    const fetchImpl = vi.fn(async () => json([testRow()]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    const rows = await client.listTests(SET);

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/rest/v1/mock_tests');
    expect(url).toContain(`set_id=eq.${SET}`);
    expect(url).toContain('order=position.asc');

    expect(rows).toEqual([
      {
        id: TEST,
        setId: SET,
        title: 'Test 1',
        position: 1,
        durationMin: 120,
        isFreeSample: true,
      },
    ]);
  });

  it('inserts a new set as a DRAFT owned by the session user', async () => {
    const fetchImpl = vi.fn(async () => json([setRow()]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await client.saveSet(EDIT);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.teacher_id).toBe(TEACHER);
    expect(body.exam_id).toBe(EXAM);
    expect(body.price_inr).toBe(349);
    // V11 and V9: a save never sets a status. Only publish_mock_set() does.
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('id');
  });

  it('patches an existing set by id, and moves neither owner nor exam', async () => {
    const fetchImpl = vi.fn(async () => json([setRow({ price_inr: 399 })]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    const saved = await client.saveSet({ ...EDIT, id: SET, priceInr: 399 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toContain(`id=eq.${SET}`);

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.price_inr).toBe(399);
    expect(body).not.toHaveProperty('teacher_id');
    expect(body).not.toHaveProperty('exam_id');
    expect(body).not.toHaveProperty('status');

    expect(saved.priceInr).toBe(399);
  });

  it('refuses to send a price outside the band, even past the route', async () => {
    const fetchImpl = vi.fn(async () => json([setRow()]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await expect(client.saveSet({ ...EDIT, priceInr: 500 })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a named MockSetConflict for a title that is taken', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'duplicate key' }, 409));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await expect(client.saveSet(EDIT)).rejects.toMatchObject({
      name: 'MockSetConflict',
    });
  });

  it('treats an empty PATCH reply as a failure, so a screen never says saved', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = mocks(fetchImpl as unknown as typeof fetch);
    await expect(client.saveSet({ ...EDIT, id: SET })).rejects.toThrow();
  });

  it('adds a test to a set, with the set id from the URL and not the body', async () => {
    const fetchImpl = vi.fn(async () => json([testRow()]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    const saved = await client.saveTest(SET, {
      title: 'Test 1',
      position: 1,
      durationMin: 120,
      isFreeSample: true,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/mock_tests');
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.set_id).toBe(SET);
    expect(body.is_free_sample).toBe(true);
    expect(body.duration_min).toBe(120);

    expect(saved.position).toBe(1);
  });

  it('refuses a free sample at position 2 before the request (V11)', async () => {
    const fetchImpl = vi.fn(async () => json([testRow()]));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await expect(
      client.saveTest(SET, {
        title: 'Test 2',
        position: 2,
        durationMin: 60,
        isFreeSample: true,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a named MockTestConflict for a position that is taken', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'duplicate key' }, 409));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await expect(
      client.saveTest(SET, {
        title: 'Test 1',
        position: 1,
        durationMin: 60,
        isFreeSample: false,
      }),
    ).rejects.toMatchObject({ name: 'MockTestConflict' });
  });

  it('calls publish_mock_set and reports how many questions went live', async () => {
    const fetchImpl = vi.fn(async () => json(40));
    const client = mocks(fetchImpl as unknown as typeof fetch);

    expect(await client.publishSet(SET)).toBe(40);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/rpc/publish_mock_set');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ set_id: SET });
  });

  it('turns the Postgres error CODE into the name the route switches on', async () => {
    const cases = [
      ['23514', 'PublishUnchecked'],
      ['55000', 'PublishEmpty'],
      ['42501', 'PublishForbidden'],
      ['P0002', 'PublishForbidden'],
    ] as const;

    for (const [code, name] of cases) {
      const fetchImpl = vi.fn(async () =>
        json({ code, message: 'constraint "mock_sets_price_check"' }, 400),
      );
      const client = mocks(fetchImpl as unknown as typeof fetch);

      await expect(client.publishSet(SET)).rejects.toMatchObject({ name });
    }
  });

  it('never leaks the Postgres message into the thrown error', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ code: '23514', message: 'policy "mock_sets_update_own"' }, 400),
    );
    const client = mocks(fetchImpl as unknown as typeof fetch);

    await expect(client.publishSet(SET)).rejects.toThrow(/^publish refused$/);
  });

  it('reads the caller own revenue share, and falls back to 50 (X3)', async () => {
    const found = vi.fn(async () => json([{ revenue_share_pct: 60 }]));
    expect(await mocks(found as unknown as typeof fetch).readMyShare()).toBe(60);

    const [url] = found.mock.calls[0] as unknown as [string];
    expect(url).toContain('/rest/v1/teachers');
    expect(url).toContain('revenue_share_pct');

    const broken = vi.fn(async () => json({ message: 'nope' }, 500));
    expect(await mocks(broken as unknown as typeof fetch).readMyShare()).toBe(50);

    const nonsense = vi.fn(async () => json([{ revenue_share_pct: 'half' }]));
    expect(await mocks(nonsense as unknown as typeof fetch).readMyShare()).toBe(50);
  });
});
