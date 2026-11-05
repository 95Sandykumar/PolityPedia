/**
 * The server-side AiClient, driven with a FAKE fetch (issue 22-revision-api).
 *
 * No real network call and no real key (web/CLAUDE.md). What is checked:
 *
 *  * the student's OWN access token goes on every call, so Postgres RLS and
 *    `auth.uid()` decide (there is no service-role key here);
 *  * `claim` passes the one word through, and anything it does not know
 *    fails closed to `no_plan`, never to `claimed`;
 *  * a saved row is turned into something the UI can draw, and a broken one
 *    is reported as not readable rather than as an empty explanation;
 *  * `finish` treats "saved nothing" as a failure, so the route refunds.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseAiClient } from '../supabase-ai-client';
import type { ExplainResult, RevisionRequest } from '../types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-not-real',
};

const REQUEST: RevisionRequest = {
  questionId: '11111111-1111-4111-8111-111111111111',
  lang: 'en',
};

const RESULT: ExplainResult = {
  body: {
    exam: 'UGC NET',
    topic: 'Parliament',
    question: 'Council of States',
    sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
    remember: 'Rajya Sabha = Council of States.',
  },
  sources: [{ title: 'India Code', url: 'https://www.indiacode.nic.in/' }],
  model: 'claude-haiku-5-5',
  tokensIn: 900,
  tokensOut: 450,
  searches: 2,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch, env: Record<string, string> = ENV) {
  return createSupabaseAiClient({ accessToken: 'student-token', env, fetchImpl });
}

describe('createSupabaseAiClient: configuration', () => {
  it('is not configured with no env', () => {
    expect(clientWith(vi.fn() as unknown as typeof fetch, {}).isConfigured()).toBe(false);
  });

  it('reads the env lazily, so importing the module needs nothing', () => {
    expect(() => createSupabaseAiClient({ accessToken: '' })).not.toThrow();
  });
});

describe('createSupabaseAiClient: claim', () => {
  it('calls the SQL function with the student token and returns its word', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, 'claimed'));
    const code = await clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST);

    expect(code).toBe('claimed');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/claim_ai_explanation');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer student-token');
    expect(headers.apikey).toBe('anon-key-not-real');
    expect(JSON.parse(String(init.body))).toEqual({
      question_id: REQUEST.questionId,
      lang: 'en',
    });
  });

  it('fails closed on a word it does not know', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, 'whatever'));
    expect(await clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST)).toBe('no_plan');
  });

  it('throws on an HTTP failure, and never quotes the body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(403, { message: 'permission denied for table ai_usage' }),
    );
    await expect(clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST)).rejects.toThrow(
      /status 403$/,
    );
  });
});

describe('createSupabaseAiClient: get', () => {
  it('turns a saved row into something the UI can draw', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, [
        {
          question_id: REQUEST.questionId,
          lang: 'en',
          status: 'ready',
          body: RESULT.body,
          sources: RESULT.sources,
          audio_path: null,
          edited_by_teacher: true,
        },
      ]),
    );

    const found = await clientWith(fetchImpl as unknown as typeof fetch).get(REQUEST);

    expect(found?.status).toBe('ready');
    expect(found?.body?.sections).toEqual(RESULT.body.sections);
    expect(found?.sources).toEqual(RESULT.sources);
    expect(found?.editedByTeacher).toBe(true);
  });

  it('reports a body with no sections as not readable', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, [
        { question_id: REQUEST.questionId, lang: 'en', status: 'ready', body: {}, sources: [] },
      ]),
    );
    const found = await clientWith(fetchImpl as unknown as typeof fetch).get(REQUEST);
    expect(found?.body).toBeNull();
  });

  it('returns null when there is no row and on a read failure', async () => {
    const empty = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, []));
    expect(await clientWith(empty as unknown as typeof fetch).get(REQUEST)).toBeNull();

    const broken = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(500, {}));
    expect(await clientWith(broken as unknown as typeof fetch).get(REQUEST)).toBeNull();
  });
});

describe('createSupabaseAiClient: question', () => {
  it('reads the stem, options and exam name for the prompt', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, [
        {
          stem: 'Which house is the Council of States?',
          options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
          correct_idx: 1,
          teacher_explanation: 'Article 80.',
          topic_id: null,
          papers: { exams: { name_en: 'UGC NET' } },
        },
      ]),
    );

    const found = await clientWith(fetchImpl as unknown as typeof fetch).question(
      REQUEST.questionId,
    );

    expect(found).toEqual({
      exam: 'UGC NET',
      topic: null,
      stem: 'Which house is the Council of States?',
      options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
      correctIdx: 1,
      teacherExplanation: 'Article 80.',
    });
  });

  it('returns null for a row RLS hid or a row with three options', async () => {
    const hidden = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, []));
    expect(
      await clientWith(hidden as unknown as typeof fetch).question(REQUEST.questionId),
    ).toBeNull();

    const broken = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, [{ stem: 'x', options: ['a', 'b', 'c'], correct_idx: 0 }]),
    );
    expect(
      await clientWith(broken as unknown as typeof fetch).question(REQUEST.questionId),
    ).toBeNull();
  });
});

describe('createSupabaseAiClient: finish and fail', () => {
  it('sends the model, tokens and search count for the cost check', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    await clientWith(fetchImpl as unknown as typeof fetch).finish(REQUEST, RESULT);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rpc/finish_ai_explanation');
    expect(JSON.parse(String(init.body))).toMatchObject({
      question_id: REQUEST.questionId,
      lang: 'en',
      model: 'claude-haiku-5-5',
      tokens_in: 900,
      tokens_out: 450,
      searches: 2,
    });
  });

  it('treats "saved nothing" as a failure, so the route gives the call back', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, false));
    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).finish(REQUEST, RESULT),
    ).rejects.toThrow(/saved nothing/);
  });

  it('reports the failure to Postgres so the counter is restored', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    await clientWith(fetchImpl as unknown as typeof fetch).fail(REQUEST);
    expect(fetchImpl.mock.calls[0][0]).toContain('/rpc/fail_ai_explanation');
  });
});
