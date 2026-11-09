/**
 * The read result type and its probe (issue 54a-read-error-core).
 *
 * Definition of done 1: "A small shared type separates 'ok but empty' from
 * 'failed' for a student read."
 */
import { describe, expect, it } from 'vitest';
import { readFailed, readOk, readWithProbe } from '../read-result';

describe('read-result', () => {
  it('an ok read with zero rows is ok, not failed', () => {
    const result = readOk<string[]>([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('a failed read carries no data', () => {
    expect(readFailed().ok).toBe(false);
  });

  describe('readWithProbe', () => {
    it('is ok when every request answered 200, even with zero rows', async () => {
      const result = await readWithProbe(
        async (fetchImpl) => {
          const res = await fetchImpl('https://db.test/rest/v1/mock_sets');
          return (await res.json()) as unknown[];
        },
        async () => new Response('[]', { status: 200 }),
      );

      expect(result).toEqual({ ok: true, data: [] });
    });

    it('is failed when a request answered 400, even though the read returned a list', async () => {
      const result = await readWithProbe(
        async (fetchImpl) => {
          const res = await fetchImpl('https://db.test/rest/v1/mock_sets');
          // What the real Supabase clients do today: swallow it into [].
          return res.ok ? ((await res.json()) as unknown[]) : [];
        },
        async () => new Response('{"message":"bad request"}', { status: 400 }),
      );

      expect(result.ok).toBe(false);
    });

    it('is failed when one request of several answered 400', async () => {
      let call = 0;
      const result = await readWithProbe(
        async (fetchImpl) => {
          await fetchImpl('https://db.test/a');
          await fetchImpl('https://db.test/b');
          return ['one row'];
        },
        async () => {
          call += 1;
          return new Response('[]', { status: call === 2 ? 400 : 200 });
        },
      );

      expect(result.ok).toBe(false);
    });

    it('is failed when the request itself throws', async () => {
      const result = await readWithProbe(
        async (fetchImpl) => {
          await fetchImpl('https://db.test/a').catch(() => null);
          return [];
        },
        async () => {
          throw new Error('network down');
        },
      );

      expect(result.ok).toBe(false);
    });

    it('is failed when the read itself throws', async () => {
      const result = await readWithProbe(async () => {
        throw new Error('boom');
      });

      expect(result.ok).toBe(false);
    });

    it('never reads the global fetch at import time', async () => {
      // The probe is built per read, so a module-level `fetch` capture would
      // break the build with no environment (web/CLAUDE.md).
      const result = await readWithProbe(async (fetchImpl) => {
        expect(typeof fetchImpl).toBe('function');
        return 'done';
      });
      expect(result).toEqual({ ok: true, data: 'done' });
    });
  });
});
