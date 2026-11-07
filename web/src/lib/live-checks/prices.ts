/**
 * The ONE price table for the live checks (issue 42-h3-live-check-tools).
 *
 * Every dollar figure the three tools in `web/jobs/live-checks/` print comes
 * from this file, so when the Anthropic pricing page moves, Boss edits these
 * numbers and nothing else.
 *
 * EVERY NUMBER BELOW IS UNVERIFIED. They are design.md's cost table, which
 * took them from the `claude-api` skill cached 2026-10-06. Checking them
 * against the live pricing page is part of ticket H3; until then a printed
 * cost is an estimate with real token counts in it, not a bill.
 *
 * Pure data. No env, no fetch, no clock, so it is safe to import anywhere.
 */

export interface ModelPrice {
  /** Dollars per 1,000,000 input tokens. */
  inputUsdPerMillion: number;
  /** Dollars per 1,000,000 output tokens. */
  outputUsdPerMillion: number;
}

/**
 * The models the two live checks actually call.
 *
 * Both of them are Haiku: `SPLIT_MODEL` in `src/lib/split/types.ts` and
 * `EXPLAINER_MODEL` in `src/lib/ai/types.ts` are the same pin (PRD F6). The
 * other two tiers are here because `tokenCostUsd` refuses a model it has no
 * price for, and a hand-run check against Sonnet should print a number rather
 * than an error.
 *
 * UNVERIFIED, check the Anthropic pricing page. Dated 2026-11-07.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // UNVERIFIED, check the Anthropic pricing page. Dated 2026-11-07.
  // design.md line 59: "$0.10 in / $0.50 out per 1M tokens".
  'claude-haiku-5-5': { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
  // UNVERIFIED, check the Anthropic pricing page. Dated 2026-11-07.
  'claude-sonnet-5': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  // UNVERIFIED, check the Anthropic pricing page. Dated 2026-11-07.
  'claude-opus-5': { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
};

/**
 * One server-side web search.
 *
 * UNVERIFIED, check the Anthropic pricing page. Dated 2026-11-07.
 * design.md line 60: "$10 per 1,000 searches", so $0.01 each. At
 * `max_uses: 2` that is $0.02 of the $0.022 estimate, which is why this one
 * number decides almost the whole AI bill.
 */
export const WEB_SEARCH_USD_PER_SEARCH = 0.01;

/**
 * AS3: what design.md line 61 estimates one NEW explanation costs.
 *
 * The point of `explain-cost.ts` is to put a measured number next to this
 * one. UNVERIFIED, check the Anthropic pricing page. Dated 2026-11-07.
 */
export const EXPLAIN_COST_ESTIMATE_USD = 0.022;

/** AS2: the share of questions the split has to get right. PRD target. */
export const SPLIT_ACCURACY_TARGET = 0.8;

/**
 * How close two normalised strings must be to count as the same.
 *
 * 0.97 from the issue: tight enough that a changed word is a miss, loose
 * enough that one lost accent or a stray PDF character is not.
 */
export const SPLIT_MATCH_THRESHOLD = 0.97;

/** Where to go when a number here looks wrong. Printed in every report. */
export const PRICES_SOURCE = 'web/src/lib/live-checks/prices.ts';

/** The warning every report carries, so no number is read as a bill. */
export const PRICES_WARNING =
  'UNVERIFIED prices from ' + PRICES_SOURCE + ', check the Anthropic pricing page';
