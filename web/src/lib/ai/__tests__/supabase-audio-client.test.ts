/**
 * The server-side ExplanationAudioClient, driven with a FAKE fetch
 * (issues 25-revision-audio and 41-ai-finish-server-only).
 *
 * No real network call and no real key (web/CLAUDE.md). What is checked is
 * WHICH KEY GOES ON WHICH CALL:
 *
 *  * `claimAudio` carries the student's OWN access token. The question
 *    visibility rule, the exam lock and the race all read `auth.uid()`;
 *  * `finishAudio` and `failAudio` carry the SERVER-ONLY key, because 0040
 *    granted both functions to `service_role` alone. Without that a student
 *    could cancel a voice call that was still running, and the next read
 *    would start and bill a second one for the same words;
 *  * with no server-only key set, both THROW, and neither falls back to the
 *    student's token;
 *  * no key, no token and no claim secret ever reaches a thrown message.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseAudioClient } from '../supabase-audio-client';
import type { RevisionRequest } from '../types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-not-real',
  // Server only, never `NEXT_PUBLIC_`.
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-not-real',
};

/** The same install with the server-only key missing. */
const ENV_NO_SERVICE_KEY = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-not-real',
};

const REQUEST: RevisionRequest = {
  questionId: '11111111-1111-4111-8111-111111111111',
  lang: 'en',
};

const PATH = 'explanations/11111111-1111-4111-8111-111111111111/en.mp3';

/** Not a real one: the real one is a uuid Postgres keeps only a sha256 of. */
const CLAIM_SECRET = '44444444-4444-4444-8444-444444444444';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch, env: Record<string, string> = ENV) {
  return createSupabaseAudioClient({ accessToken: 'student-token', env, fetchImpl });
}

function headersOf(fetchImpl: { mock: { calls: unknown[][] } }, index: number) {
  const init = fetchImpl.mock.calls[index][1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('createSupabaseAudioClient: configuration', () => {
  it('is not configured with no env', () => {
    expect(clientWith(vi.fn() as unknown as typeof fetch, {}).isConfigured()).toBe(false);
  });

  it('reads the env lazily, so importing the module needs nothing', () => {
    expect(() => createSupabaseAudioClient({ accessToken: '' })).not.toThrow();
  });
});

describe('createSupabaseAudioClient: claimAudio', () => {
  it('uses the student token and returns the word and the secret', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { code: 'claimed', secret: CLAIM_SECRET }),
    );
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).claimAudio(REQUEST);

    expect(outcome).toEqual({ code: 'claimed', secret: CLAIM_SECRET });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://project.supabase.co/rest/v1/rpc/claim_explanation_audio',
    );

    const headers = headersOf(fetchImpl, 0);
    expect(headers.authorization).toBe('Bearer student-token');
    expect(headers.apikey).toBe(ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    // The server-only key is never on this call.
    expect(headers.apikey).not.toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('still claims with no server-only key set: the claim does not need one', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { code: 'making' }),
    );
    const outcome = await clientWith(
      fetchImpl as unknown as typeof fetch,
      ENV_NO_SERVICE_KEY,
    ).claimAudio(REQUEST);
    expect(outcome.code).toBe('making');
  });
});

describe('createSupabaseAudioClient: finishAudio and failAudio', () => {
  it('sends the path and the secret with the SERVER-ONLY key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    const saved = await clientWith(fetchImpl as unknown as typeof fetch).finishAudio(
      REQUEST,
      PATH,
      CLAIM_SECRET,
    );

    expect(saved).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toContain('/rpc/finish_explanation_audio');

    const headers = headersOf(fetchImpl, 0);
    expect(headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(headers.authorization).toBe('Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(headers.authorization).not.toContain('student-token');

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      question_id: REQUEST.questionId,
      lang: 'en',
      audio_path: PATH,
      claim_secret: CLAIM_SECRET,
    });
  });

  it('reports "saved nothing" as false, so the step releases the slot', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, false),
    );
    expect(
      await clientWith(fetchImpl as unknown as typeof fetch).finishAudio(
        REQUEST,
        PATH,
        CLAIM_SECRET,
      ),
    ).toBe(false);
  });

  it('releases the slot with the SERVER-ONLY key and the secret', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    await clientWith(fetchImpl as unknown as typeof fetch).failAudio(REQUEST, CLAIM_SECRET);

    expect(fetchImpl.mock.calls[0][0]).toContain('/rpc/fail_explanation_audio');
    const headers = headersOf(fetchImpl, 0);
    expect(headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(headers.authorization).toBe('Bearer ' + ENV.SUPABASE_SERVICE_ROLE_KEY);

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      question_id: REQUEST.questionId,
      lang: 'en',
      claim_secret: CLAIM_SECRET,
    });
  });

  it('still posts a null secret rather than dropping the field', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, false),
    );
    await clientWith(fetchImpl as unknown as typeof fetch).failAudio(REQUEST, null);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ claim_secret: null });
  });

  it('throws with no server-only key, and never falls back to the student', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    const client = clientWith(fetchImpl as unknown as typeof fetch, ENV_NO_SERVICE_KEY);

    await expect(client.finishAudio(REQUEST, PATH, CLAIM_SECRET)).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    await expect(client.failAudio(REQUEST, CLAIM_SECRET)).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the secret or either key in a thrown message', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(403, { message: 'permission denied ' + ENV.SUPABASE_SERVICE_ROLE_KEY }),
    );
    const client = clientWith(fetchImpl as unknown as typeof fetch);

    const thrown = await client.failAudio(REQUEST, CLAIM_SECRET).catch((e: Error) => e);
    const text = String((thrown as Error).message);
    expect(text).toContain('403');
    expect(text).not.toContain(CLAIM_SECRET);
    expect(text).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(text).not.toContain('student-token');
  });
});
