/**
 * AS3: what one new explanation really costs
 * (issue 42-h3-live-check-tools, ticket H3).
 *
 * It builds the explanation prompt and calls the real explainer exactly as the
 * app does, then prints `tokens_in`, `tokens_out`, `searches`, the dollar cost
 * from the price table, design.md's $0.022 estimate, the gap in percent, and
 * the explanation text so Boss can read what the money bought.
 *
 *   cd web
 *   node --import ./jobs/register-alias.mjs jobs/live-checks/explain-cost.ts \
 *     <questionId> --lang en --runs 1
 *
 * IT SPENDS MONEY: one real Haiku call WITH WEB SEARCH per run, and search is
 * about 90 percent of the cost. `--runs` is capped at 5 for that reason.
 *
 * IT WRITES NOTHING TO THE DATABASE. The app's route would call
 * `claim_ai_explanation()` first and `finish_ai_explanation()` after; this
 * tool calls neither, so no row is created, no student's 30-a-day is spent and
 * the measured explanation is thrown away. That is the whole difference
 * between this file and `src/lib/ai/revision-route.ts`.
 */
import { createAnthropicExplainer } from '@/lib/ai/anthropic-explainer';
import { EXPLAINER_MODEL } from '@/lib/ai/types';
import type { Lang } from '@/lib/i18n';
import {
  explanationToText,
  formatExplainReport,
  tokenCostUsd,
  type ExplainRun,
} from '@/lib/live-checks/core';
import { readQuestionForExplain } from './rest';
import {
  flagNumber,
  isEntryPoint,
  publish,
  readArgs,
  requireEnv,
  requireUuid,
  run,
  stop,
  type Args,
} from './shared';

const USAGE =
  'Usage: node --import ./jobs/register-alias.mjs jobs/live-checks/explain-cost.ts ' +
  '<questionId> [--lang en|hi] [--runs 1]';

/** At most 5, because each run is a real billed call with two searches. */
const MAX_RUNS = 5;

/**
 * `--lang`, as the stored LANGUAGE the app uses, or stop.
 *
 * Never the display mode `both`: an explanation is written in one language,
 * like the question it explains (`readRevisionRequest` makes the same choice).
 */
function readLang(args: Args): Lang {
  const raw = args.flags.lang;
  if (raw === undefined || raw === true) return 'en';
  if (raw === 'en' || raw === 'hi') return raw;
  return stop('live check stopped: --lang must be en or hi.');
}

export async function main(): Promise<void> {
  const args = readArgs();
  requireEnv(['ANTHROPIC_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

  const questionArg = args.positional[0];
  if (!questionArg) stop('live check stopped: no question id. ' + USAGE);
  const questionId = requireUuid(questionArg, 'the question id');

  const lang = readLang(args);
  const runs = flagNumber(args, 'runs', 1, 1, MAX_RUNS);

  const question = await readQuestionForExplain(questionId);
  if (!question) {
    stop(
      `live check stopped: question ${questionId} is not readable, or it has no answer key. ` +
        'Nothing was sent to Claude.',
    );
  }

  const explainer = createAnthropicExplainer();
  const request = {
    lang,
    exam: question.exam,
    topic: question.topic,
    question: {
      stem: question.stem,
      options: question.options,
      correctIdx: question.correctIdx,
      teacherExplanation: question.teacherExplanation,
    },
  };

  console.log(
    `[explain-cost] ${runs} real ${EXPLAINER_MODEL} call${runs === 1 ? '' : 's'} with web search, ` +
      `lang=${lang}. Nothing is written to the database.`,
  );

  const done: ExplainRun[] = [];
  for (let i = 0; i < runs; i += 1) {
    const result = await explainer.explain(request);
    done.push({
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      searches: result.searches,
      model: result.model,
      cost: tokenCostUsd({
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        searches: result.searches,
      }),
      text: explanationToText({ body: result.body, sources: result.sources }),
    });
    console.log(
      `[explain-cost] run ${i + 1} of ${runs}: tokens_in=${result.tokensIn} ` +
        `tokens_out=${result.tokensOut} searches=${result.searches}`,
    );
  }

  const date = new Date();
  await publish({
    name: 'explain-cost',
    report: formatExplainReport({ questionId, lang, runs: done, date }),
    date,
  });
}

if (isEntryPoint('explain-cost')) run(main);
