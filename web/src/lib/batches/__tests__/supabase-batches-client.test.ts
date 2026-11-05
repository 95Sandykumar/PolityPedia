/**
 * The server-side `BatchesClient` over Supabase REST (issue 19-batches).
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md). What is asserted is the shape of the
 * request, because that shape is what RLS sees:
 *
 *  * every call carries the CALLER'S OWN access token, never a service key,
 *  * a created batch takes its `teacher_id` from the session, never a body,
 *  * no call ever sends `join_code`: the database default owns it,
 *  * a read never asks for `select=*`,
 *  * a missing env gives an empty list, not a crash,
 *  * a bad join code comes back as a NAMED error, not a Postgres message.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseBatchesClient } from '../supabase-batches-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const TEACHER = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';
const BATCH_2 = '66666666-6666-4666-8666-666666666666';
const SET = '44444444-4444-4444-8444-444444444444';

const ROW = {
  id: BATCH,
  teacher_id: TEACHER,
  name: 'Morning batch',
  join_code: 'ABC234',
};

function jsonOnce(body: unknown, status = 200) {
  return vi.fn(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status }),
  );
}

function client(fetchImpl: typeof fetch, env: Record<string, string | undefined> = ENV) {
  return createSupabaseBatchesClient({
    accessToken: 'caller.token',
    userId: TEACHER,
    env,
    fetchImpl,
  });
}

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
  it('reads the caller own batches, newest first, named columns only', async () => {
    const doFetch = jsonOnce([ROW]);
    const found = await client(doFetch as unknown as typeof fetch).listMine();

    expect(found).toEqual([
      { id: BATCH, teacherId: TEACHER, name: 'Morning batch', joinCode: 'ABC234' },
    ]);

    const { url, headers } = callAt(doFetch);
    expect(url).toContain('/rest/v1/batches?');
    expect(url).toContain('teacher_id=eq.' + TEACHER);
    expect(url).toContain('order=created_at.desc');
    expect(url).not.toContain('select=*');
    expect(headers.authorization).toBe('Bearer caller.token');
  });

  it('is empty with no env, and fires no request', async () => {
    const doFetch = jsonOnce([ROW]);
    const found = await client(doFetch as unknown as typeof fetch, {}).listMine();
    expect(found).toEqual([]);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('drops a row it cannot read rather than half-filling it', async () => {
    const doFetch = jsonOnce([{ id: BATCH, teacher_id: TEACHER }, ROW]);
    const found = await client(doFetch as unknown as typeof fetch).listMine();
    expect(found).toHaveLength(1);
  });

  it('is empty when Supabase answers an error', async () => {
    const doFetch = jsonOnce({ message: 'nope' }, 500);
    expect(await client(doFetch as unknown as typeof fetch).listMine()).toEqual([]);
  });
});

describe('readOne', () => {
  it('reads one batch by id', async () => {
    const doFetch = jsonOnce([ROW]);
    const found = await client(doFetch as unknown as typeof fetch).readOne(BATCH);
    expect(found?.joinCode).toBe('ABC234');
    expect(callAt(doFetch).url).toContain('id=eq.' + BATCH);
  });

  it('is null for an id that is not a uuid, and fires no request', async () => {
    const doFetch = jsonOnce([ROW]);
    expect(await client(doFetch as unknown as typeof fetch).readOne('../../etc')).toBeNull();
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('saveBatch', () => {
  it('creates a batch with the owner from the SESSION and no join code', async () => {
    const doFetch = jsonOnce([ROW]);
    const saved = await client(doFetch as unknown as typeof fetch).saveBatch({
      id: null,
      name: 'Morning batch',
    });
    expect(saved.joinCode).toBe('ABC234');

    const { init } = callAt(doFetch);
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ teacher_id: TEACHER, name: 'Morning batch' });
    // The code is the database's to pick, so it is never in a request.
    expect(body.join_code).toBeUndefined();
  });

  it('renames with a PATCH that never moves the owner or the code', async () => {
    const doFetch = jsonOnce([{ ...ROW, name: 'Evening batch' }]);
    await client(doFetch as unknown as typeof fetch).saveBatch({
      id: BATCH,
      name: 'Evening batch',
    });

    const { url, init } = callAt(doFetch);
    expect(init.method).toBe('PATCH');
    expect(url).toContain('id=eq.' + BATCH);
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Evening batch' });
  });

  it('throws for a batch id that is not a uuid, before any request', async () => {
    const doFetch = jsonOnce([ROW]);
    await expect(
      client(doFetch as unknown as typeof fetch).saveBatch({ id: 'nope', name: 'x' }),
    ).rejects.toThrow();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('throws when a PATCH comes back empty: RLS hid somebody else row', async () => {
    const doFetch = jsonOnce([]);
    await expect(
      client(doFetch as unknown as typeof fetch).saveBatch({ id: BATCH, name: 'x' }),
    ).rejects.toThrow();
  });

  it('throws a message with the status and no response body', async () => {
    const doFetch = jsonOnce({ message: 'policy "batches_insert_own" blocked it' }, 401);
    await expect(
      client(doFetch as unknown as typeof fetch).saveBatch({ id: null, name: 'x' }),
    ).rejects.toThrow(/401/);
    await expect(
      client(jsonOnce({ message: 'policy "batches_insert_own"' }, 401) as unknown as typeof fetch)
        .saveBatch({ id: null, name: 'x' }),
    ).rejects.not.toThrow(/batches_insert_own/);
  });
});

describe('listMembers', () => {
  it('reads the roll of several batches in one request', async () => {
    const doFetch = jsonOnce([
      { batch_id: BATCH, user_id: STUDENT, joined_at: '2026-11-05T10:00:00Z' },
    ]);
    const found = await client(doFetch as unknown as typeof fetch).listMembers([BATCH, BATCH_2]);

    expect(found).toEqual([
      { batchId: BATCH, userId: STUDENT, joinedAt: '2026-11-05T10:00:00Z' },
    ]);
    const { url } = callAt(doFetch);
    expect(url).toContain('batch_id=in.(' + BATCH + ',' + BATCH_2 + ')');
  });

  it('is empty for an empty list, and fires no request', async () => {
    const doFetch = jsonOnce([]);
    expect(await client(doFetch as unknown as typeof fetch).listMembers([])).toEqual([]);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('drops an id that is not a uuid instead of putting it in a URL', async () => {
    const doFetch = jsonOnce([]);
    await client(doFetch as unknown as typeof fetch).listMembers([BATCH, 'or 1=1']);
    expect(callAt(doFetch).url).toContain('batch_id=in.(' + BATCH + ')');
  });
});

describe('removeMember', () => {
  it('deletes exactly one membership row', async () => {
    const doFetch = jsonOnce(null, 204);
    await client(doFetch as unknown as typeof fetch).removeMember(BATCH, STUDENT);

    const { url, init } = callAt(doFetch);
    expect(init.method).toBe('DELETE');
    expect(url).toContain('batch_id=eq.' + BATCH);
    expect(url).toContain('user_id=eq.' + STUDENT);
  });

  it('throws for ids that are not uuids, before any request', async () => {
    const doFetch = jsonOnce(null, 204);
    await expect(
      client(doFetch as unknown as typeof fetch).removeMember('x', STUDENT),
    ).rejects.toThrow();
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('the free sets of a batch', () => {
  it('lists them', async () => {
    const doFetch = jsonOnce([{ batch_id: BATCH, set_id: SET }]);
    const found = await client(doFetch as unknown as typeof fetch).listSets(BATCH);
    expect(found).toEqual([{ batchId: BATCH, setId: SET }]);
    expect(callAt(doFetch).url).toContain('batch_id=eq.' + BATCH);
  });

  it('adds one', async () => {
    const doFetch = jsonOnce(null, 204);
    await client(doFetch as unknown as typeof fetch).addSet(BATCH, SET);

    const { init } = callAt(doFetch);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ batch_id: BATCH, set_id: SET });
    // Adding a set the batch already has is a double tap, not an error.
    expect((init.headers as Record<string, string>).prefer).toContain('merge-duplicates');
  });

  it('drops one', async () => {
    const doFetch = jsonOnce(null, 204);
    await client(doFetch as unknown as typeof fetch).dropSet(BATCH, SET);

    const { url, init } = callAt(doFetch);
    expect(init.method).toBe('DELETE');
    expect(url).toContain('batch_id=eq.' + BATCH);
    expect(url).toContain('set_id=eq.' + SET);
  });

  it('throws when the add is refused', async () => {
    const doFetch = jsonOnce({ message: 'policy blocked it' }, 401);
    await expect(
      client(doFetch as unknown as typeof fetch).addSet(BATCH, SET),
    ).rejects.toThrow(/401/);
  });
});

describe('join', () => {
  it('calls the join_batch function with the code and returns the batch id', async () => {
    const doFetch = jsonOnce(BATCH);
    const joined = await client(doFetch as unknown as typeof fetch).join('ABC234');
    expect(joined).toBe(BATCH);

    const { url, init } = callAt(doFetch);
    expect(url).toContain('/rest/v1/rpc/join_batch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ for_code: 'ABC234' });
  });

  it('names a P0002 so the route can answer 404 without reading a message', async () => {
    const doFetch = jsonOnce({ code: 'P0002', message: 'no batch has that join code' }, 400);
    await expect(
      client(doFetch as unknown as typeof fetch).join('ZZZZZZ'),
    ).rejects.toMatchObject({ name: 'JoinNotFound' });
  });

  it('throws a plain status error for anything else', async () => {
    const doFetch = jsonOnce({ code: '42501', message: 'permission denied' }, 403);
    await expect(client(doFetch as unknown as typeof fetch).join('ABC234')).rejects.toThrow(
      /403/,
    );
  });

  it('throws for a code that is not a join code, before any request', async () => {
    const doFetch = jsonOnce(BATCH);
    await expect(client(doFetch as unknown as typeof fetch).join('OOPS')).rejects.toThrow();
    expect(doFetch).not.toHaveBeenCalled();
  });
});
