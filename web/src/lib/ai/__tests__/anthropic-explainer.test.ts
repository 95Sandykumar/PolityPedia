/**
 * The real Explainer, driven with a FAKE fetch (issue 22-revision-api).
 *
 * No real network call and no real key anywhere here (web/CLAUDE.md). What is
 * checked is the four things the issue pins down:
 *
 *  * F6: the model is `claude-haiku-5-5`.
 *  * F4: ONE call, web search with `max_uses: 2`.
 *  * X7: the new web search tool type first, the old one as a fallback.
 *  * C:  the untrusted wrapper is in the body that goes over the wire.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicExplainer } from '../anthropic-explainer';
import { UNTRUSTED_OPEN } from '../prompt';
import { EXPLAINER_MODEL, MAX_WEB_SEARCHES, type ExplainRequest } from '../types';

const REQUEST: ExplainRequest = {
  lang: 'en',
  exam: 'UGC NET',
  topic: 'Parliament',
  question: {
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    correctIdx: 1,
    teacherExplanation: 'Article 80.',
  },
};

const OUTPUT = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Council of States',
  sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
  remember: 'Rajya Sabha = Council of States.',
  sources: [{ title: 'India Code', url: 'https://www.indiacode.nic.in/' }],
};

/** A Messages API reply with one web search and one JSON text block. */
function okBody(output: unknown = OUTPUT) {
  return {
    model: EXPLAINER_MODEL,
    stop_reason: 'end_turn',
    usage: { input_tokens: 900, output_tokens: 450 },
    content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x' }] },
      { type: 'text', text: JSON.stringify(output) },
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const KEY = { ANTHROPIC_API_KEY: 'test-key-not-real' };

function explainerWith(fetchImpl: typeof fetch, env: Record<string, string> = KEY) {
  return createAnthropicExplainer({ env, fetchImpl });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('createAnthropicExplainer: configuration', () => {
  it('is not configured with no key, and never calls out', async () => {
    const fetchImpl = vi.fn();
    const explainer = explainerWith(fetchImpl as unknown as typeof fetch, {});

    expect(explainer.isConfigured()).toBe(false);
    await expect(explainer.explain(REQUEST)).rejects.toThrow(/not configured/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the key lazily, so importing the module needs no env', () => {
    expect(() => createAnthropicExplainer()).not.toThrow();
  });
});

describe('createAnthropicExplainer: the one call', () => {
  it('asks Haiku once, with web search capped at 2 uses', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, okBody()));
    const result = await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const body = sentBody(fetchImpl);
    expect(body.model).toBe(EXPLAINER_MODEL);

    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('web_search');
    expect(tools[0].max_uses).toBe(MAX_WEB_SEARCHES);
    expect(tools[0].type).toBe('web_search_20260209');

    expect(result.model).toBe(EXPLAINER_MODEL);
    expect(result.tokensIn).toBe(900);
    expect(result.tokensOut).toBe(450);
    expect(result.searches).toBe(1);
    expect(result.body.sections[0].heading).toBe('Answer');
    expect(result.sources).toEqual(OUTPUT.sources);
  });

  it('sends the untrusted wrapper and the key in a header, never a URL', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, okBody()));
    await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(url).not.toContain('test-key-not-real');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key-not-real');

    expect(String(init.body)).toContain(UNTRUSTED_OPEN);
  });

  it('asks for the structured shape the UI draws', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, okBody()));
    await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);

    const format = (sentBody(fetchImpl).output_config as Record<string, unknown>)
      .format as Record<string, unknown>;
    const schema = format.schema as { required: string[]; properties: Record<string, unknown> };
    expect(format.type).toBe('json_schema');
    expect(schema.required).toEqual([
      'exam',
      'topic',
      'question',
      'sections',
      'remember',
      'sources',
    ]);
    expect(schema.properties.sections).toBeTruthy();
  });

  it('sends no temperature and no thinking budget (Haiku rule)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, okBody()));
    await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);

    const body = sentBody(fetchImpl);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('thinking');
  });
});

describe('createAnthropicExplainer: X7, the web search tool type', () => {
  it('falls back to the older type when the new one is refused', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools: Array<{ type: string }> };
      if (body.tools[0].type === 'web_search_20260209') {
        return jsonResponse(400, {
          error: { type: 'invalid_request_error', message: 'tools.0: unexpected type' },
        });
      }
      return jsonResponse(200, okBody());
    });

    const result = await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchImpl, 1).tools).toMatchObject([{ type: 'web_search_20250305' }]);
    expect(result.body.remember).toBe(OUTPUT.remember);
  });

  it('does not retry a refusal that has nothing to do with the tool', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(400, { error: { type: 'invalid_request_error', message: 'max_tokens too big' } }),
    );

    await expect(
      explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a server error, so one ask is never two calls', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(529, { error: { message: 'overloaded' } }));

    await expect(
      explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST),
    ).rejects.toThrow(/529/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createAnthropicExplainer: a bad answer is a failure', () => {
  it('throws when the model returns no JSON', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, {
        model: EXPLAINER_MODEL,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'Sorry, I cannot.' }],
      }),
    );
    await expect(
      explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST),
    ).rejects.toThrow();
  });

  it('throws when a section is missing its heading', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, okBody({ ...OUTPUT, sections: [{ body: 'no heading' }] })),
    );
    await expect(
      explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST),
    ).rejects.toThrow();
  });

  it('throws on a refusal instead of saving an empty explanation', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, {
        model: EXPLAINER_MODEL,
        stop_reason: 'refusal',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [],
      }),
    );
    await expect(
      explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST),
    ).rejects.toThrow(/refus/i);
  });

  it('drops a source whose url is not http', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(
        200,
        okBody({
          ...OUTPUT,
          sources: [
            { title: 'Bad', url: 'javascript:alert(1)' },
            { title: 'Good', url: 'https://www.indiacode.nic.in/' },
          ],
        }),
      ),
    );
    const result = await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);
    expect(result.sources).toEqual([{ title: 'Good', url: 'https://www.indiacode.nic.in/' }]);
  });

  it('never reports more searches than F4 allows', async () => {
    const many = {
      ...okBody(),
      content: [
        { type: 'web_search_tool_result', content: [] },
        { type: 'web_search_tool_result', content: [] },
        { type: 'web_search_tool_result', content: [] },
        { type: 'text', text: JSON.stringify(OUTPUT) },
      ],
    };
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, many));
    const result = await explainerWith(fetchImpl as unknown as typeof fetch).explain(REQUEST);
    expect(result.searches).toBe(MAX_WEB_SEARCHES);
  });
});
