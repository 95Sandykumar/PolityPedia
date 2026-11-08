/**
 * Remove and restore: the route logic, the Supabase client and the browser
 * client (issue 45-keep-money-and-scores).
 *
 * The rules this file pins:
 *
 *  * nobody signed in -> 401; a student -> 403; no keys -> 503; a bad id -> 400.
 *  * the route never asks for a hard delete: it calls `remove`, and the answer
 *    (`deleted` or `archived`) comes from Postgres.
 *  * a row that is not the caller's -> 404, the same as a missing one.
 *  * a restore after 30 days -> 409.
 *  * the Supabase client sends the signed-in token (never a service key), reads
 *    the error CODE only, and refuses an answer it does not recognise.
 *  * the browser client turns the HTTP status into one of our codes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import { handleRemove, handleRestore } from '../archive-route';
import { createBrowserArchiveClient } from '../browser-archive-client';
import { createSupabaseArchiveClient } from '../supabase-archive-client';
import { archivePath, restorePath, type ArchiveClient } from '../types';

const ID = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'caller-token',
    refreshToken: 'refresh',
    userId: TEACHER,
    role: 'teacher',
    teacherStatus: 'approved',
    ...over,
  };
}

function client(over: Partial<ArchiveClient> = {}): ArchiveClient {
  return {
    isConfigured: () => true,
    remove: async () => 'archived',
    restore: async () => undefined,
    ...over,
  };
}

function named(name: string): Error {
  return Object.assign(new Error('refused'), { name });
}

describe('handleRemove', () => {
  it('turns away nobody-signed-in, a student and a missing config', async () => {
    const remove = vi.fn();
    expect(
      (await handleRemove({ kind: 'mock-set', id: ID, session: null, client: client({ remove }) }))
        .status,
    ).toBe(401);
    expect(
      (
        await handleRemove({
          kind: 'mock-set',
          id: ID,
          session: session({ role: 'student', teacherStatus: undefined }),
          client: client({ remove }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await handleRemove({
          kind: 'mock-set',
          id: ID,
          session: session(),
          client: client({ remove, isConfigured: () => false }),
        })
      ).status,
    ).toBe(503);
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a uuid before any request', async () => {
    const remove = vi.fn();
    const reply = await handleRemove({
      kind: 'paper',
      id: '../../x',
      session: session(),
      client: client({ remove }),
    });
    expect(reply.status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });

  it('passes Postgres\'s answer through, deleted or archived', async () => {
    for (const result of ['deleted', 'archived'] as const) {
      const reply = await handleRemove({
        kind: 'batch',
        id: ID,
        session: session(),
        client: client({ remove: async () => result }),
      });
      expect(reply).toEqual({ status: 200, body: { ok: true, result } });
    }
  });

  it('asks for the right kind and id', async () => {
    const remove = vi.fn(async () => 'deleted' as const);
    await handleRemove({ kind: 'mock-test', id: ID, session: session(), client: client({ remove }) });
    expect(remove).toHaveBeenCalledWith('mock-test', ID);
  });

  it('answers 404 for a row that is not yours, and a fixed word for anything else', async () => {
    const stranger = await handleRemove({
      kind: 'mock-set',
      id: ID,
      session: session(),
      client: client({
        remove: async () => {
          throw named('ArchiveNotFound');
        },
      }),
    });
    expect(stranger).toEqual({ status: 404, body: { error: 'not found' } });

    const broken = await handleRemove({
      kind: 'mock-set',
      id: ID,
      session: session(),
      client: client({
        remove: async () => {
          throw new Error('violates foreign key constraint "purchases_set_id_fkey"');
        },
      }),
    });
    expect(broken).toEqual({ status: 502, body: { error: 'remove failed' } });
  });
});

describe('handleRestore', () => {
  it('restores, and maps the refusals', async () => {
    const ok = await handleRestore({ kind: 'mock-set', id: ID, session: session(), client: client() });
    expect(ok).toEqual({ status: 200, body: { ok: true } });

    const late = await handleRestore({
      kind: 'mock-set',
      id: ID,
      session: session(),
      client: client({
        restore: async () => {
          throw named('RestoreWindowOver');
        },
      }),
    });
    expect(late).toEqual({ status: 409, body: { error: 'window over' } });

    const stranger = await handleRestore({
      kind: 'mock-set',
      id: ID,
      session: session(),
      client: client({
        restore: async () => {
          throw named('ArchiveNotFound');
        },
      }),
    });
    expect(stranger.status).toBe(404);
  });

  it('turns away a student and nobody-signed-in', async () => {
    expect(
      (await handleRestore({ kind: 'paper', id: ID, session: null, client: client() })).status,
    ).toBe(401);
    expect(
      (
        await handleRestore({
          kind: 'paper',
          id: ID,
          session: session({ role: 'student', teacherStatus: undefined }),
          client: client(),
        })
      ).status,
    ).toBe(403);
  });
});

describe('createSupabaseArchiveClient', () => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' };

  function reply(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('calls the function with the signed-in token and the right parameter', async () => {
    const fetchImpl = vi.fn(async () => reply(200, 'archived'));
    const c = createSupabaseArchiveClient({ accessToken: 'tok', env, fetchImpl });

    expect(await c.remove('mock-set', ID)).toBe('archived');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.supabase.co/rest/v1/rpc/remove_mock_set');
    expect(JSON.parse(String(init.body))).toEqual({ for_set: ID });
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers.apikey).toBe('anon');
  });

  it('uses the parameter name of each kind', async () => {
    const fetchImpl = vi.fn(async () => reply(200, 'deleted'));
    const c = createSupabaseArchiveClient({ accessToken: 'tok', env, fetchImpl });
    await c.remove('mock-test', ID);
    await c.remove('paper', ID);
    await c.remove('batch', ID);
    const sent = fetchImpl.mock.calls.map((call) => {
      const [url, init] = call as unknown as [string, RequestInit];
      return [url.split('/').pop(), Object.keys(JSON.parse(String(init.body)))[0]];
    });
    expect(sent).toEqual([
      ['remove_mock_test', 'for_test'],
      ['remove_paper', 'for_paper'],
      ['remove_batch', 'for_batch'],
    ]);
  });

  it('never claims a result it does not recognise', async () => {
    const c = createSupabaseArchiveClient({
      accessToken: 'tok',
      env,
      fetchImpl: vi.fn(async () => reply(200, 'maybe')),
    });
    await expect(c.remove('paper', ID)).rejects.toThrow(/unknown result/);
  });

  it('maps the Postgres error codes to names, and hides the message', async () => {
    const make = (code: string) =>
      createSupabaseArchiveClient({
        accessToken: 'tok',
        env,
        fetchImpl: vi.fn(async () => reply(400, { code, message: 'violates "purchases_set_id_fkey"' })),
      });

    await expect(make('P0002').remove('mock-set', ID)).rejects.toMatchObject({ name: 'ArchiveNotFound' });
    await expect(make('55000').restore('mock-set', ID)).rejects.toMatchObject({ name: 'RestoreWindowOver' });
    const unknown = make('XX000').remove('mock-set', ID);
    await expect(unknown).rejects.toThrow('Supabase archive call failed with status 400');
    await expect(unknown).rejects.not.toThrow(/purchases_set_id_fkey/);
  });

  it('refuses an id that is not a uuid, and reports a missing config', async () => {
    const fetchImpl = vi.fn();
    const c = createSupabaseArchiveClient({ accessToken: 'tok', env, fetchImpl });
    await expect(c.remove('mock-set', 'nope')).rejects.toThrow('uuid');
    expect(fetchImpl).not.toHaveBeenCalled();

    const unset = createSupabaseArchiveClient({ accessToken: 'tok', env: {} });
    expect(unset.isConfigured()).toBe(false);
  });
});

describe('createBrowserArchiveClient', () => {
  it('DELETEs the object path and returns the answer', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: 'archived' }), { status: 200 }),
    );
    const c = createBrowserArchiveClient(fetchImpl);

    expect(await c.remove('mock-set', ID)).toBe('archived');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(archivePath('mock-set', ID));
    expect(url).toBe(`/api/teacher/mock-sets/${ID}`);
    expect(init.method).toBe('DELETE');
  });

  it('POSTs the restore path', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    await createBrowserArchiveClient(fetchImpl).restore('batch', ID);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(restorePath('batch', ID));
    expect(url).toBe(`/api/teacher/batches/${ID}/restore`);
    expect(init.method).toBe('POST');
  });

  it('turns 404 and 409 into our codes and never says deleted over a guess', async () => {
    const status = (code: number, body = '{}') =>
      createBrowserArchiveClient(vi.fn(async () => new Response(body, { status: code })));

    await expect(status(404).remove('paper', ID)).rejects.toThrow('not-found');
    await expect(status(409).restore('paper', ID)).rejects.toThrow('window-over');
    await expect(status(500).remove('paper', ID)).rejects.toThrow('status 500');
    // A 200 with no result is not a result.
    await expect(status(200, '{"ok":true}').remove('paper', ID)).rejects.toThrow();
  });
});

describe('the list readers carry archived_at', () => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' };

  it('a set row with archived_at reads as archived; without it, the key is absent', async () => {
    const row = {
      id: ID,
      teacher_id: TEACHER,
      exam_id: 'a4000001-0000-4000-8000-000000000001',
      title: 'Sold set',
      price_inr: 299,
      status: 'live',
    };
    const reader = (extra: Record<string, unknown>) =>
      createSupabaseMocksClient({
        accessToken: 'tok',
        userId: TEACHER,
        env,
        fetchImpl: vi.fn(async () => new Response(JSON.stringify([{ ...row, ...extra }]), { status: 200 })),
      });

    const archived = await reader({ archived_at: '2026-11-01T00:00:00Z' }).readOne(ID);
    expect(archived?.archivedAt).toBe('2026-11-01T00:00:00Z');

    const live = await reader({ archived_at: null }).readOne(ID);
    expect(live).not.toBeNull();
    expect('archivedAt' in (live ?? {})).toBe(false);
  });
});
