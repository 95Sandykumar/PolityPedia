/**
 * The server-only Supabase caller for the AI finish and fail
 * (issue 41-ai-finish-server-only).
 *
 * No real network call and no real key (web/CLAUDE.md). What is checked:
 *
 *  * the env reader needs BOTH the URL and the server-only key, and the key
 *    is never read from a `NEXT_PUBLIC_` name;
 *  * the env is read inside the call, not at import time, so `npm run build`
 *    and `npm test` work with nothing set;
 *  * a missing key THROWS with a message that names the variable and nothing
 *    else, and sends no request at all;
 *  * the key goes in both PostgREST headers, and no error message ever
 *    quotes a response body.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAiServiceRpc, readAiServiceEnv } from '../service-env';

const URL_OK = 'https://project.supabase.co';
const KEY = 'service-role-key-not-real';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readAiServiceEnv', () => {
  it('needs both the URL and the server-only key', () => {
    expect(readAiServiceEnv({})).toBeNull();
    expect(readAiServiceEnv({ NEXT_PUBLIC_SUPABASE_URL: URL_OK })).toBeNull();
    expect(readAiServiceEnv({ SUPABASE_SERVICE_ROLE_KEY: KEY })).toBeNull();
    expect(
      readAiServiceEnv({ NEXT_PUBLIC_SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY }),
    ).toEqual({ url: URL_OK, serviceRoleKey: KEY });
  });

  it('trims a trailing slash off the URL, so no path is ever doubled', () => {
    expect(
      readAiServiceEnv({
        NEXT_PUBLIC_SUPABASE_URL: URL_OK + '///',
        SUPABASE_SERVICE_ROLE_KEY: KEY,
      })?.url,
    ).toBe(URL_OK);
  });

  it('ignores a NEXT_PUBLIC_ copy of the key, which must never exist', () => {
    // A `NEXT_PUBLIC_` name is inlined into the browser bundle by Next.js, so
    // reading one here would be the whole leak this issue closes.
    expect(
      readAiServiceEnv({
        NEXT_PUBLIC_SUPABASE_URL: URL_OK,
        NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: KEY,
      }),
    ).toBeNull();
  });

  it('treats blank as missing', () => {
    expect(
      readAiServiceEnv({ NEXT_PUBLIC_SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: '   ' }),
    ).toBeNull();
  });
});

describe('createAiServiceRpc', () => {
  it('is safe to build with no env at all', () => {
    expect(() => createAiServiceRpc()).not.toThrow();
  });

  it('posts the key in both headers and returns the parsed reply', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    const rpc = createAiServiceRpc({
      env: { NEXT_PUBLIC_SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await rpc('fail_ai_explanation', { lang: 'en' })).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK + '/rest/v1/rpc/fail_ai_explanation');
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');

    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(KEY);
    expect(headers.authorization).toBe('Bearer ' + KEY);
  });

  it('throws naming the variable, and sends nothing, when the key is missing', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    const rpc = createAiServiceRpc({
      env: { NEXT_PUBLIC_SUPABASE_URL: URL_OK },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(rpc('finish_ai_explanation', {})).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports the HTTP status and never the response body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(403, { message: 'permission denied for function ' + KEY }),
    );
    const rpc = createAiServiceRpc({
      env: { NEXT_PUBLIC_SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const thrown = await rpc('finish_ai_explanation', {}).catch((e: Error) => e);
    const text = String((thrown as Error).message);
    expect(text).toContain('403');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('permission denied');
  });
});
