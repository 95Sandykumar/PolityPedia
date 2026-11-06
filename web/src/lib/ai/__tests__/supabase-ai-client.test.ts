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

/**
 * A claim secret (issue 37-ai-claim-secret). Not a real one: the real one is
 * a `gen_random_uuid()` Postgres keeps only a sha256 of.
 */
const CLAIM_SECRET = '33333333-3333-4333-8333-333333333333';

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
  it('calls the SQL function with the student token and returns its word and secret', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { code: 'claimed', secret: CLAIM_SECRET }),
    );
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST);

    expect(outcome).toEqual({ code: 'claimed', secret: CLAIM_SECRET });
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

  it('fails closed on a word it does not know, and keeps no secret', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { code: 'whatever', secret: CLAIM_SECRET }),
    );
    expect(await clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST)).toEqual({
      code: 'no_plan',
      secret: null,
    });
  });

  it('drops a secret that arrives on any word but claimed', async () => {
    // Only a `claimed` row has a call of ours in flight, so a secret on
    // `ready` or `generating` is noise at best (issue 37-ai-claim-secret).
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { code: 'generating', secret: CLAIM_SECRET }),
    );
    expect(await clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST)).toEqual({
      code: 'generating',
      secret: null,
    });
  });

  it('drops a secret that is not a uuid', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { code: 'claimed', secret: 'not-a-uuid' }),
    );
    expect(await clientWith(fetchImpl as unknown as typeof fetch).claim(REQUEST)).toEqual({
      code: 'claimed',
      secret: null,
    });
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
  it('sends the model, tokens, search count and the claim secret', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    await clientWith(fetchImpl as unknown as typeof fetch).finish(REQUEST, RESULT, CLAIM_SECRET);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rpc/finish_ai_explanation');
    expect(JSON.parse(String(init.body))).toMatchObject({
      question_id: REQUEST.questionId,
      lang: 'en',
      model: 'claude-haiku-5-5',
      tokens_in: 900,
      tokens_out: 450,
      searches: 2,
      // Issue 37-ai-claim-secret: without this Postgres saves nothing.
      claim_secret: CLAIM_SECRET,
    });
  });

  it('treats "saved nothing" as a failure, so the route gives the call back', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, false));
    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).finish(REQUEST, RESULT, CLAIM_SECRET),
    ).rejects.toThrow(/saved nothing/);
  });

  it('reports the failure to Postgres with the secret, so the counter is restored', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, true));
    await clientWith(fetchImpl as unknown as typeof fetch).fail(REQUEST, CLAIM_SECRET);
    expect(fetchImpl.mock.calls[0][0]).toContain('/rpc/fail_ai_explanation');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      question_id: REQUEST.questionId,
      lang: 'en',
      claim_secret: CLAIM_SECRET,
    });
  });

  it('still posts a null secret rather than dropping the field', async () => {
    // Postgres refuses it, which is the point: fail closed, and never let a
    // missing secret look like a successful refund.
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, false));
    await clientWith(fetchImpl as unknown as typeof fetch).fail(REQUEST, null);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ claim_secret: null });
  });
});

/**
 * Neither piece of answer key material is a COLUMN of this read any more
 * (issues 30-exam-key-lock and 36-exam-leaks-close).
 *
 * `prompt.ts` sends the correct option to the model and quotes the teacher's
 * prose beside it, so this is the file that holds both at once. Each now
 * arrives through its own definer function, and each of those refuses while
 * the student has an open exam sitting. Asking for either column in the
 * select would make the WHOLE request 403 and break Revision for everybody.
 */
describe('createSupabaseAiClient: question reads no key columns', () => {
  const ROW = {
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    topic_id: null,
    papers: { exams: { name_en: 'UGC NET' } },
  };

  /** The table read, then the two RPCs, each answering only to its own url. */
  function routed(
    key: unknown[] = [{ correct_idx: 1 }],
    prose: unknown[] = [{ teacher_explanation: 'Article 80.' }],
  ) {
    return vi.fn(async (url: string, _init: RequestInit) => {
      if (url.includes('/rpc/question_explanations')) return jsonResponse(200, prose);
      if (url.includes('/rpc/question_keys')) return jsonResponse(200, key);
      return jsonResponse(200, [ROW]);
    });
  }

  it('names neither correct_idx nor teacher_explanation in the select', async () => {
    const fetchImpl = routed();
    await clientWith(fetchImpl as unknown as typeof fetch).question(REQUEST.questionId);

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/questions?select=');
    expect(url).not.toContain('correct_idx');
    expect(url).not.toContain('teacher_explanation');
  });

  it('builds the prompt input from both definer functions', async () => {
    const fetchImpl = routed();
    const found = await clientWith(fetchImpl as unknown as typeof fetch).question(
      REQUEST.questionId,
    );

    expect(found).toEqual({
      exam: 'UGC NET',
      topic: null,
      stem: ROW.stem,
      options: ROW.options,
      correctIdx: 1,
      teacherExplanation: 'Article 80.',
    });
    expect(
      fetchImpl.mock.calls.some((one) => String(one[0]).includes('/rpc/question_explanations')),
    ).toBe(true);
  });

  it('still returns a question when only the prose is refused', async () => {
    // The prose is optional in the prompt, so a 403 on it only makes a
    // thinner prompt. It must not cost the student their claim.
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.includes('/rpc/question_explanations')) return jsonResponse(403, { code: '42501' });
      if (url.includes('/rpc/question_keys')) return jsonResponse(200, [{ correct_idx: 1 }]);
      return jsonResponse(200, [ROW]);
    });

    const found = await clientWith(fetchImpl as unknown as typeof fetch).question(
      REQUEST.questionId,
    );
    expect(found?.correctIdx).toBe(1);
    expect(found?.teacherExplanation).toBeNull();
  });

  it('returns null when the KEY is refused, which is what mid-exam looks like', async () => {
    // No key, no explanation: the route turns this null into 404 and gives
    // the claim back without charging anybody (F-E5).
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.includes('/rpc/question_explanations')) {
        return jsonResponse(200, [{ teacher_explanation: 'Article 80.' }]);
      }
      if (url.includes('/rpc/question_keys')) return jsonResponse(403, { code: '42501' });
      return jsonResponse(200, [ROW]);
    });

    expect(
      await clientWith(fetchImpl as unknown as typeof fetch).question(REQUEST.questionId),
    ).toBeNull();
  });
});
