/**
 * The real Explainer: Claude Haiku over the Messages API
 * (issue 22-revision-api).
 *
 * Constraints this file exists to keep:
 *  * F6  -- the model is Haiku (`claude-haiku-5-5`).
 *  * F4  -- ONE call per explanation, web search capped at `max_uses: 2`.
 *  * X7  -- try the current web search tool type, fall back to the older one.
 *  * C   -- the question, options and teacher text go in untrusted-wrapped,
 *           built by `prompt.ts`.
 *
 * Why plain `fetch` and not `@anthropic-ai/sdk`: the SDK is not a dependency
 * of this app, and the whole project already talks to its outside services
 * (Supabase, and later Razorpay and TTS) over `fetch` behind a small
 * interface, for the same two reasons. One, nothing of the client can leak
 * into a browser bundle. Two, a test can inject `fetchImpl` and there is no
 * network stack to mock. If the SDK is added later, only this file changes:
 * `Explainer` is the seam.
 *
 * Haiku rules (Boss's model note): no `temperature`, `top_p` or `top_k`, no
 * `thinking` budget, no prefill, read text blocks by `type`, and leave room
 * in `max_tokens`.
 *
 * The env is read lazily inside every call, so importing this file can never
 * break a build that has no environment variables (web/CLAUDE.md).
 *
 * Security: the key is a secret. It goes in a header, never in a URL, and no
 * console call lives in this file. Thrown errors carry a fixed message plus
 * the HTTP status, never a response body.
 */
import { buildExplainPrompt, explainSystemPrompt } from './prompt';
import {
  EXPLAINER_MODEL,
  MAX_WEB_SEARCHES,
  type ExplainRequest,
  type ExplainResult,
  type Explainer,
  type ExplanationBody,
  type ExplanationSection,
  type ExplanationSource,
} from './types';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * X7: the dynamic-filtering web search tool, then the basic one.
 *
 * Both are tried in this order on the FIRST request only. A 400 that names
 * the tool means this deployment's model does not have the newer type yet;
 * anything else is a real failure and is not retried, because a retry would
 * be a second billed call for one explanation (F4).
 */
const SEARCH_TOOL_TYPES = ['web_search_20260209', 'web_search_20250305'] as const;

/** Room for a long explanation plus whatever thinking Haiku does. */
const MAX_TOKENS = 4_000;

/** The shape the UI draws. `strict`-style schema: no extra keys. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exam', 'topic', 'question', 'sections', 'remember', 'sources'],
  properties: {
    exam: { type: 'string', description: 'The exam this question is from.' },
    topic: { type: 'string', description: 'The syllabus topic, two or three words.' },
    question: { type: 'string', description: 'The question in one short line.' },
    sections: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    remember: { type: 'string', description: 'One line to memorise.' },
    sources: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
  },
} as const;

export interface AnthropicExplainerOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface ApiTextBlock {
  type: string;
  text?: unknown;
  content?: unknown;
}

interface ApiReply {
  model?: unknown;
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  content?: unknown;
}

function readString(value: unknown, max = 4_000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Only http(s). A `javascript:` "source" would be a link we render. */
function readUrl(value: unknown): string | null {
  const raw = readString(value, 2_000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function readSections(value: unknown): ExplanationSection[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ExplanationSection[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { heading, body } = raw as Record<string, unknown>;
    const h = readString(heading, 120);
    const b = readString(body);
    // A section with no heading is not renderable, so the whole answer is
    // treated as a failure and the student's call is given back.
    if (!h || !b) return null;
    out.push({ heading: h, body: b });
  }
  return out;
}

/** Bad sources are dropped, not fatal: the explanation is still useful. */
function readSources(value: unknown): ExplanationSource[] {
  if (!Array.isArray(value)) return [];
  const out: ExplanationSource[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { title, url } = raw as Record<string, unknown>;
    const link = readUrl(url);
    if (!link) continue;
    out.push({ title: readString(title, 200) ?? link, url: link });
  }
  return out;
}

/** The first text block that parses as the object we asked for. */
function readOutput(blocks: ApiTextBlock[]): { body: ExplanationBody; sources: ExplanationSource[] } | null {
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    if (!text.startsWith('{')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const raw = parsed as Record<string, unknown>;
    const sections = readSections(raw.sections);
    if (!sections) continue;

    return {
      body: {
        exam: readString(raw.exam, 200) ?? '',
        topic: readString(raw.topic, 200) ?? '',
        question: readString(raw.question, 1_000) ?? '',
        sections,
        remember: readString(raw.remember, 1_000) ?? '',
      },
      sources: readSources(raw.sources),
    };
  }
  return null;
}

/** How many searches the call used. Capped, so a stored count obeys F4. */
function countSearches(blocks: ApiTextBlock[]): number {
  const used = blocks.filter((b) => b.type === 'web_search_tool_result').length;
  return Math.min(used, MAX_WEB_SEARCHES);
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * Is this 400 about the web search tool type, and nothing else?
 *
 * Deliberately narrow. Retrying any other 400 would spend a second call on a
 * request that is going to be refused again.
 */
function isToolTypeRefusal(status: number, text: string): boolean {
  if (status !== 400) return false;
  const lower = text.toLowerCase();
  return lower.includes('tool') || lower.includes('web_search');
}

export function createAnthropicExplainer(
  options: AnthropicExplainerOptions = {},
): Explainer {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const key = () => (options.env ?? process.env).ANTHROPIC_API_KEY?.trim() || null;
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  async function ask(request: ExplainRequest, toolType: string): Promise<ApiReply> {
    const apiKey = key();
    if (!apiKey) throw new Error('Claude is not configured');

    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: EXPLAINER_MODEL,
        max_tokens: MAX_TOKENS,
        system: explainSystemPrompt(),
        messages: [{ role: 'user', content: buildExplainPrompt(request) }],
        // F4: one search tool, two uses, and nothing else. No code execution
        // alongside it: a second environment only confuses the model.
        tools: [{ type: toolType, name: 'web_search', max_uses: MAX_WEB_SEARCHES }],
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      }),
      cache: 'no-store',
    });

    if (!res.ok) {
      // The body is read only to decide whether the tool type was the
      // problem. It is never put in the thrown message: it can quote a key.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = '';
      }
      const error = new Error('Claude call failed with status ' + res.status);
      (error as Error & { toolTypeRefused?: boolean }).toolTypeRefused = isToolTypeRefusal(
        res.status,
        detail,
      );
      throw error;
    }

    return (await res.json()) as ApiReply;
  }

  return {
    isConfigured() {
      return key() !== null;
    },

    async explain(request: ExplainRequest): Promise<ExplainResult> {
      let reply: ApiReply | null = null;

      for (let i = 0; i < SEARCH_TOOL_TYPES.length; i += 1) {
        try {
          reply = await ask(request, SEARCH_TOOL_TYPES[i]);
          break;
        } catch (error) {
          const refused = (error as Error & { toolTypeRefused?: boolean }).toolTypeRefused;
          const last = i === SEARCH_TOOL_TYPES.length - 1;
          // X7: only a tool-type refusal earns the second attempt. Anything
          // else, including a 5xx, is one failed ask and one refund.
          if (!refused || last) throw error;
        }
      }
      if (!reply) throw new Error('Claude returned nothing');

      if (reply.stop_reason === 'refusal') {
        throw new Error('Claude refused the question');
      }

      const blocks = Array.isArray(reply.content) ? (reply.content as ApiTextBlock[]) : [];
      const output = readOutput(blocks);
      // No readable answer is a failure, not an empty explanation: a saved
      // empty one would never be regenerated (F-F4).
      if (!output) throw new Error('Claude returned no usable explanation');

      return {
        body: output.body,
        sources: output.sources,
        model: readString(reply.model, 100) ?? EXPLAINER_MODEL,
        tokensIn: readCount(reply.usage?.input_tokens),
        tokensOut: readCount(reply.usage?.output_tokens),
        searches: countSearches(blocks),
      };
    },
  };
}
