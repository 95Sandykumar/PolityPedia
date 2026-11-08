/**
 * X7: which web search tool type Haiku 5.5 accepts
 * (issue 42-h3-live-check-tools, ticket H3).
 *
 * It sends ONE tiny real request per tool type in `SEARCH_TOOL_TYPES` and
 * reports which ones the API accepts, the status and error text of the ones it
 * refuses, and which one the app will end up using (the first accepted).
 *
 *   cd web
 *   node --import ./jobs/register-alias.mjs jobs/live-checks/search-probe.ts
 *
 * COST: a handful of input tokens per request. The prompt is one short
 * sentence that gives the model no reason to search, so a search is not
 * expected to be billed; `max_uses: 1` caps it either way. Run this one FIRST,
 * before `explain-cost.ts`, because it is the cheap question.
 *
 * WHY IT DOES NOT GO THROUGH `createAnthropicExplainer`. The explainer stops
 * at the first type that works, which is the right thing for a student and
 * the wrong thing for a measurement: Boss needs to know about BOTH types. So
 * this file sends the same shaped request itself, reading the tool list, the
 * model pin and the API version from the app rather than repeating them.
 *
 * IT WRITES NOTHING TO THE DATABASE and needs no Supabase key at all.
 */
import { SEARCH_TOOL_TYPES } from '@/lib/ai/anthropic-explainer';
import { EXPLAINER_MODEL } from '@/lib/ai/types';
import {
  cut,
  formatProbeReport,
  readProbeOutcome,
  redactSecrets,
  type ProbeAttempt,
} from '@/lib/live-checks/core';
import { ANTHROPIC_VERSION } from '@/lib/split/haiku-splitter';
import { isEntryPoint, publish, readArgs, requireEnv, run } from './shared';

/** The same endpoint `anthropic-explainer.ts` posts to. */
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Tiny on purpose: the question is "does the API take this tool type". */
const PROBE_MAX_TOKENS = 64;

/** A sentence with no reason to search, so a search is unlikely to be billed. */
const PROBE_PROMPT = 'Reply with the single word ok.';

/** How much of the API's error text the report keeps. */
const ERROR_LIMIT = 300;

/** One probe. Never throws: a dead network is a result, not a crash. */
export async function probe(input: {
  toolType: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeAttempt> {
  const doFetch: typeof fetch = input.fetchImpl ?? fetch;

  try {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': input.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: EXPLAINER_MODEL,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        tools: [{ type: input.toolType, name: 'web_search', max_uses: 1 }],
      }),
      cache: 'no-store',
    });

    if (res.ok) return { toolType: input.toolType, status: res.status, accepted: true, error: null };

    // The body IS the answer here: it is the only place the API says why.
    // Redacted before it goes anywhere, because an error body can quote the
    // request, and cut, because a 4 KB JSON error is not a report.
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    return {
      toolType: input.toolType,
      status: res.status,
      accepted: false,
      error: cut(redactSecrets(detail, [input.apiKey]), ERROR_LIMIT) || 'no error text',
    };
  } catch (error) {
    // No HTTP answer at all: DNS, TLS, a timeout.
    return {
      toolType: input.toolType,
      status: 0,
      accepted: false,
      error: redactSecrets(error instanceof Error ? error.message : 'unknown error', [input.apiKey]),
    };
  }
}

export async function main(): Promise<void> {
  readArgs();
  requireEnv(['ANTHROPIC_API_KEY']);
  // Read AFTER the check, inside the function: lazy env (web/CLAUDE.md).
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();

  console.log(
    `[search-probe] ${SEARCH_TOOL_TYPES.length} tiny ${EXPLAINER_MODEL} requests, one per tool type.`,
  );

  const attempts: ProbeAttempt[] = [];
  for (const toolType of SEARCH_TOOL_TYPES) {
    const attempt = await probe({ toolType, apiKey });
    attempts.push(attempt);
    console.log(
      `[search-probe] ${toolType}: ${attempt.accepted ? 'accepted' : 'rejected'} (HTTP ${attempt.status})`,
    );
  }

  // SEARCH_TOOL_TYPES is passed as the order, so the reported "will use" is
  // the app's own preference and not an accident of this loop.
  const outcome = readProbeOutcome(attempts, [...SEARCH_TOOL_TYPES]);
  const date = new Date();

  let report = formatProbeReport({ outcome, model: EXPLAINER_MODEL, date });

  // A 401 or a 429 is not an answer about the tool type, and reading it as one
  // would send Boss hunting for a tool name when the key or the rate limit is
  // the problem.
  const notAboutTheTool = outcome.rejected.filter((one) => one.status !== 400);
  if (notAboutTheTool.length > 0) {
    report +=
      '\n' +
      [
        '## Careful: some rejections were not about the tool type',
        '',
        ...notAboutTheTool.map(
          (one) =>
            `${one.toolType} came back HTTP ${one.status}, which is a key, quota or network ` +
            'problem rather than an unsupported tool type. Fix that first, then run this again.',
        ),
        '',
      ].join('\n');
  }

  await publish({ name: 'search-probe', report, date, secrets: [apiKey] });
}

if (isEntryPoint('search-probe')) run(main);
