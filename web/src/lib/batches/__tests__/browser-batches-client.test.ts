/**
 * The browser-side batch client (issue 19-batches).
 *
 * The screens never hold a Supabase key and never see a token. They post to
 * our own routes, which read the caller's access token out of the httpOnly
 * session cookie and let Postgres RLS decide.
 *
 * `fetch` is injected, so nothing here touches the network.
 *
 * What is asserted: the batch id travels in the PATH, and a refusal becomes a
 * short CODE of ours, never a server message, so a Postgres policy name can
 * never reach the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBrowserBatchesClient } from '../browser-batches-client';

const BATCH = '33333333-3333-4333-8333-333333333333';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const SET = '44444444-4444-4444-8444-444444444444';

const BATCH_ROW = {
  id: BATCH,
  teacherId: '11111111-1111-4111-8111-111111111111',
  name: 'Morning batch',
  joinCode: 'ABC234',
};

function jsonOnce(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function callAt(doFetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = doFetch.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

describe('saveBatch', () => {
  it('posts the name and gives back the stored row', async () => {
    const doFetch = jsonOnce({ ok: true, batch: BATCH_ROW });
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);

    const saved = await client.saveBatch({ id: null, name: 'Morning batch' });
    expect(saved).toEqual(BATCH_ROW);

    const { url, init } = callAt(doFetch);
    expect(url).toBe('/api/teacher/batches');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ id: null, name: 'Morning batch' });
  });

  it('throws when the reply has no row, so the screen never says saved', async () => {
    const doFetch = jsonOnce({ ok: true });
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);
    await expect(client.saveBatch({ id: null, name: 'x' })).rejects.toThrow();
  });

  it('throws the status and never the server body', async () => {
    const doFetch = jsonOnce({ error: 'policy "batches_insert_own" blocked it' }, 502);
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);
    await expect(client.saveBatch({ id: null, name: 'x' })).rejects.toThrow(/502/);
  });
});

describe('removeMember', () => {
  it('puts the batch id in the PATH and the student in the body', async () => {
    const doFetch = jsonOnce({ ok: true });
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);

    await client.removeMember(BATCH, STUDENT);

    const { url, init } = callAt(doFetch);
    expect(url).toBe('/api/teacher/batches/' + BATCH + '/members');
    expect(JSON.parse(String(init.body))).toEqual({ userId: STUDENT });
  });

  it('throws on a refusal', async () => {
    const doFetch = jsonOnce({ error: 'not found' }, 404);
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);
    await expect(client.removeMember(BATCH, STUDENT)).rejects.toThrow(/404/);
  });
});

describe('setFree', () => {
  it('sends the set and the toggle to the batch route', async () => {
    const doFetch = jsonOnce({ ok: true });
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);

    await client.setFree(BATCH, SET, true);

    const { url, init } = callAt(doFetch);
    expect(url).toBe('/api/teacher/batches/' + BATCH + '/sets');
    expect(JSON.parse(String(init.body))).toEqual({ setId: SET, free: true });
  });
});

describe('join', () => {
  it('posts the code and gives back the batch id', async () => {
    const doFetch = jsonOnce({ ok: true, batchId: BATCH });
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);

    expect(await client.join('abc234')).toBe(BATCH);

    const { url, init } = callAt(doFetch);
    expect(url).toBe('/api/batches/join');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'abc234' });
  });

  it('turns a bad code into our own short code, not a server message', async () => {
    for (const status of [400, 404]) {
      const doFetch = jsonOnce({ error: 'bad code' }, status);
      const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);
      await expect(client.join('ZZZZZZ')).rejects.toThrow('bad-code');
    }
  });

  it('throws the status for anything else', async () => {
    const doFetch = jsonOnce({ error: 'join failed' }, 502);
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);
    await expect(client.join('ABC234')).rejects.toThrow(/502/);
  });

  it('throws when a 200 carries no batch id', async () => {
    const doFetch = jsonOnce({ ok: true });
    const client = createBrowserBatchesClient(doFetch as unknown as typeof fetch);
    await expect(client.join('ABC234')).rejects.toThrow();
  });
});
