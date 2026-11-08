/**
 * The live-check maths (issue 42-h3-live-check-tools).
 *
 * Ticket H3 needs Boss to measure three real numbers against the real Claude
 * API: how much of a past paper the splitter gets right (AS2, target 80
 * percent), what one new explanation costs (AS3, estimate $0.022) and which
 * web search tool type Haiku 5.5 accepts (X7).
 *
 * EVERYTHING DECIDABLE LIVES HERE, as pure functions: the text
 * normalisation, the similarity number, the question comparison, the dollar
 * maths, the probe verdict and the report text. The three scripts in
 * `web/jobs/live-checks/` are thin wrappers that read env lazily, call fetch
 * through an injectable function and print what these functions return.
 *
 * That split is the reason the tests can cover the part that can be silently
 * wrong without a network call, a key or a token spent (web/CLAUDE.md).
 *
 * No `process.env`, no `fetch`, no `Date.now()` in this file: every clock and
 * every key is an argument.
 */
import {
  EXPLAIN_COST_ESTIMATE_USD,
  MODEL_PRICES,
  PRICES_SOURCE,
  PRICES_WARNING,
  SPLIT_ACCURACY_TARGET,
  SPLIT_MATCH_THRESHOLD,
  WEB_SEARCH_USD_PER_SEARCH,
} from './prices';

/** Where a run writes its report. Relative to `web/`. */
export const RESULTS_DIR = 'live-checks/results';

/** How much of a text a report shows before it cuts. The issue's number. */
export const REPORT_TEXT_LIMIT = 200;

// --------------------------------------------------------------------------
// Text, normalised
// --------------------------------------------------------------------------

/** Zero-width space, ZWNJ, ZWJ, BOM. A PDF is full of them. */
const INVISIBLE = /[​-‍⁠﻿]/g;

/** Every single quote a PDF typesetter might use, plus the backtick. */
const SINGLE_QUOTES = /[‘’‚‛′´`]/g;

/** Every double quote, including the French ones some papers use. */
const DOUBLE_QUOTES = /[“”„‟″«»]/g;

/** Hyphen, figure dash, en dash, em dash, minus sign, full-width hyphen. */
const DASHES = /[‐-―⁃−﹘﹣－]/g;

/**
 * One text, as both sides have to look before they are compared.
 *
 * Case, whitespace, quote style and dash style are exactly the four things
 * that differ between a proofread database row and the same sentence pulled
 * out of a PDF, and none of them changes what the question asks. So they are
 * all flattened, and what is left is compared character by character.
 *
 * `NFKC` first, because it is what turns a non-breaking space into a space
 * and a ligature into its letters; doing it after the replacements would
 * leave some of those untouched.
 */
export function normaliseText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Edit distance between two strings, two rows at a time.
 *
 * Plain O(n*m) Levenshtein. A real paper is 50 to 100 questions of ~150
 * character stems, which is milliseconds; the theoretical worst case (200
 * questions of 2000 character stems) takes a few seconds, and this is a
 * one-off tool Boss runs by hand, not a request path.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1, // delete
        current[j - 1] + 1, // insert
        previous[j - 1] + cost, // substitute
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/**
 * How alike two texts are, from 0 to 1, AFTER normalisation.
 *
 * `1 - edits / length of the longer one`, so one changed character in a 50
 * character stem is 0.98 and two is 0.96. Reported raw in every report, so a
 * near miss at 0.96 reads as "almost" and not just as "wrong".
 */
export function similarity(a: string, b: string): number {
  const x = normaliseText(a);
  const y = normaliseText(b);
  if (x === y) return 1;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  return 1 - editDistance(x, y) / longest;
}

// --------------------------------------------------------------------------
// The comparison: what the splitter found against what the database holds
// --------------------------------------------------------------------------

/** One question, from either side. The two are compared field by field. */
export interface CheckQuestion {
  /** 1-based. The database's own `number`, and the splitter's position. */
  number: number;
  stem: string;
  /** Four of them in A B C D order, but a short array is tolerated here. */
  options: readonly string[];
}

export type QuestionVerdict = 'right' | 'wrong';

/** One compared question, with every similarity a report might show. */
export interface QuestionDiff {
  number: number;
  verdict: QuestionVerdict;
  stemSimilarity: number;
  /** Position by position, so option C against option C. */
  optionSimilarities: number[];
  /** The lowest of the five. What decided the verdict. */
  worstSimilarity: number;
  /**
   * True when the four options are all there but shuffled: every truth option
   * has a match somewhere in the found four, just not in its own slot. The
   * question is still WRONG, because `correct_idx` points at a slot.
   */
  optionsOutOfOrder: boolean;
  truthStem: string;
  foundStem: string;
  truthOptions: readonly string[];
  foundOptions: readonly string[];
}

export interface SplitComparison {
  threshold: number;
  target: number;
  /** How many questions the database holds for this paper (ground truth). */
  truthCount: number;
  /** How many the splitter produced AT ALL. The official PDFs are pictures. */
  foundCount: number;
  rightCount: number;
  /** Every compared question, in number order. */
  perQuestion: QuestionDiff[];
  /** The wrong ones only, for the side-by-side list in the report. */
  wrong: QuestionDiff[];
  /** Truth numbers the splitter never produced. */
  missingNumbers: number[];
  /** Numbers the splitter produced that the database does not have. */
  extraNumbers: number[];
  /** Numbers whose four options came back shuffled. */
  outOfOrderNumbers: number[];
  /** `rightCount / truthCount`, 0 when there is no truth to compare to. */
  accuracy: number;
  meetsTarget: boolean;
}

export interface CompareSplitInput {
  truth: readonly CheckQuestion[];
  found: readonly CheckQuestion[];
  threshold?: number;
  target?: number;
}

/**
 * Are these four options the same four in a different order?
 *
 * Greedy one-to-one matching: each truth option takes the first unused found
 * option it is close enough to. Four items, so the greedy answer is the right
 * answer in every case that matters, and a wrong pairing would only ever turn
 * an already-wrong question into a differently-wrong one.
 */
function sameSetDifferentOrder(
  truth: readonly string[],
  found: readonly string[],
  threshold: number,
): boolean {
  if (truth.length !== found.length) return false;
  const used = new Array<boolean>(found.length).fill(false);
  for (const one of truth) {
    let hit = -1;
    for (let j = 0; j < found.length; j += 1) {
      if (used[j]) continue;
      if (similarity(one, found[j]) >= threshold) {
        hit = j;
        break;
      }
    }
    if (hit === -1) return false;
    used[hit] = true;
  }
  return true;
}

/** One truth question against the one the splitter produced for that number. */
export function compareQuestion(
  truth: CheckQuestion,
  found: CheckQuestion,
  threshold: number = SPLIT_MATCH_THRESHOLD,
): QuestionDiff {
  const stemSimilarity = similarity(truth.stem, found.stem);

  const count = Math.max(truth.options.length, found.options.length);
  const optionSimilarities: number[] = [];
  for (let i = 0; i < count; i += 1) {
    optionSimilarities.push(similarity(truth.options[i] ?? '', found.options[i] ?? ''));
  }

  const worstSimilarity = Math.min(stemSimilarity, ...optionSimilarities);
  const positional = optionSimilarities.every((one) => one >= threshold);
  const optionsOutOfOrder =
    !positional && sameSetDifferentOrder(truth.options, found.options, threshold);

  return {
    number: truth.number,
    // RIGHT means the stem and all four options match IN PLACE. Shuffled
    // options are wrong on purpose: `correct_idx` is an index into the slots.
    verdict: stemSimilarity >= threshold && positional ? 'right' : 'wrong',
    stemSimilarity,
    optionSimilarities,
    worstSimilarity,
    optionsOutOfOrder,
    truthStem: truth.stem,
    foundStem: found.stem,
    truthOptions: truth.options,
    foundOptions: found.options,
  };
}

/**
 * The whole paper: what the splitter got right, wrong, missed and invented.
 *
 * Matched BY QUESTION NUMBER. The splitter's schema has no number field, so
 * `split-accuracy.ts` numbers its output by position (the first question it
 * returns is number 1), which is the same order the paper prints and the same
 * order the worker writes rows in.
 */
export function compareSplit(input: CompareSplitInput): SplitComparison {
  const threshold = input.threshold ?? SPLIT_MATCH_THRESHOLD;
  const target = input.target ?? SPLIT_ACCURACY_TARGET;

  const foundByNumber = new Map<number, CheckQuestion>();
  for (const one of input.found) foundByNumber.set(one.number, one);

  const truthNumbers = new Set<number>(input.truth.map((one) => one.number));

  const perQuestion: QuestionDiff[] = [];
  const missingNumbers: number[] = [];

  for (const truth of [...input.truth].sort((a, b) => a.number - b.number)) {
    const found = foundByNumber.get(truth.number);
    if (!found) {
      missingNumbers.push(truth.number);
      continue;
    }
    perQuestion.push(compareQuestion(truth, found, threshold));
  }

  const extraNumbers = input.found
    .map((one) => one.number)
    .filter((number) => !truthNumbers.has(number))
    .sort((a, b) => a - b);

  const wrong = perQuestion.filter((one) => one.verdict === 'wrong');
  const rightCount = perQuestion.length - wrong.length;
  const accuracy = input.truth.length === 0 ? 0 : rightCount / input.truth.length;

  return {
    threshold,
    target,
    truthCount: input.truth.length,
    foundCount: input.found.length,
    rightCount,
    perQuestion,
    wrong,
    missingNumbers,
    extraNumbers,
    outOfOrderNumbers: perQuestion.filter((one) => one.optionsOutOfOrder).map((one) => one.number),
    accuracy,
    meetsTarget: accuracy >= target,
  };
}

// --------------------------------------------------------------------------
// The dollars
// --------------------------------------------------------------------------

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface CostInput {
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Server-side web searches the call used. 0 for the split. */
  searches: number;
}

export interface Cost {
  model: string;
  inputUsd: number;
  outputUsd: number;
  searchUsd: number;
  totalUsd: number;
}

/**
 * What one call cost, from the price table and nothing else.
 *
 * An unknown model THROWS with the file to edit in the message, rather than
 * quietly costing $0: a report that says a call was free is worse than a
 * report that stops.
 */
export function tokenCostUsd({ model, tokensIn, tokensOut, searches }: CostInput): Cost {
  const price = MODEL_PRICES[model];
  if (!price) {
    throw new Error(`no price for model "${model}". Add it to ${PRICES_SOURCE}`);
  }
  const inputUsd = (tokensIn / 1_000_000) * price.inputUsdPerMillion;
  const outputUsd = (tokensOut / 1_000_000) * price.outputUsdPerMillion;
  const searchUsd = searches * WEB_SEARCH_USD_PER_SEARCH;
  return { model, inputUsd, outputUsd, searchUsd, totalUsd: inputUsd + outputUsd + searchUsd };
}

export interface EstimateGap {
  actualUsd: number;
  estimateUsd: number;
  differenceUsd: number;
  /** Positive when the real call costs more than the estimate. */
  differencePercent: number;
}

/** The measured cost next to design.md's estimate. AS3 in one line. */
export function compareToEstimate(
  actualUsd: number,
  estimateUsd: number = EXPLAIN_COST_ESTIMATE_USD,
): EstimateGap {
  const differenceUsd = actualUsd - estimateUsd;
  return {
    actualUsd,
    estimateUsd,
    differenceUsd,
    differencePercent: estimateUsd === 0 ? 0 : (differenceUsd / estimateUsd) * 100,
  };
}

// --------------------------------------------------------------------------
// X7: which web search tool type the API accepts
// --------------------------------------------------------------------------

/** One tiny probe request, as it came back. */
export interface ProbeAttempt {
  toolType: string;
  /** The HTTP status. 0 when the request never got an answer. */
  status: number;
  accepted: boolean;
  /** The API's own words, already redacted. Null when it accepted. */
  error: string | null;
}

export interface ProbeOutcome {
  attempts: ProbeAttempt[];
  /** In `SEARCH_TOOL_TYPES` order, which is the order the app tries them. */
  acceptedTypes: string[];
  /** What `anthropic-explainer.ts` will end up sending. Null when none work. */
  willUse: string | null;
  rejected: ProbeAttempt[];
  noneAccepted: boolean;
  /** Set only when nothing worked: the first thing for Boss to try. */
  nextStep: string | null;
}

/**
 * The probe's verdict.
 *
 * `willUse` is the first accepted type IN THE APP'S OWN ORDER, which is
 * `SEARCH_TOOL_TYPES` in `anthropic-explainer.ts`, because that is the order
 * the real explainer tries them in. `search-probe.ts` passes that constant as
 * `order`, so shuffling the probe's own loop can never change the answer.
 * With no `order` given, the order the attempts arrive in is used.
 */
export function readProbeOutcome(
  attempts: readonly ProbeAttempt[],
  order: readonly string[] = attempts.map((one) => one.toolType),
): ProbeOutcome {
  const list = [...attempts];
  const rank = new Map<string, number>(order.map((type, index) => [type, index]));
  const acceptedTypes = list
    .filter((one) => one.accepted)
    .map((one) => one.toolType)
    .sort((a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length));
  const rejected = list.filter((one) => !one.accepted);
  const noneAccepted = acceptedTypes.length === 0;

  return {
    attempts: list,
    acceptedTypes,
    willUse: acceptedTypes[0] ?? null,
    rejected,
    noneAccepted,
    nextStep: noneAccepted
      ? 'No web search tool type was accepted. First thing to try: open the Anthropic ' +
        'tool-use docs for the current web search tool type, put its name first in ' +
        'SEARCH_TOOL_TYPES in src/lib/ai/anthropic-explainer.ts, and run this probe again. ' +
        'If the docs list no type for Haiku, the fallback is to drop the tool from the ' +
        'request and accept an explanation with no sources (F4 still holds, the cost drops ' +
        'to the token cost alone).'
      : null,
  };
}

// --------------------------------------------------------------------------
// Keys: the one line a missing key prints, and the one thing never printed
// --------------------------------------------------------------------------

export interface EnvCheck {
  ok: boolean;
  /** The names of the keys that are not set. Never their values. */
  missing: string[];
  /** ONE line, naming the keys. Empty when nothing is missing. */
  message: string;
}

/**
 * Are the keys this check needs set?
 *
 * Names only, ever. A key in a terminal is a key in a scrollback buffer, and
 * the whole point of `.env.local` is that it never leaves the laptop.
 */
export function readLiveCheckEnv(input: {
  need: readonly string[];
  env: Record<string, string | undefined>;
}): EnvCheck {
  const missing = input.need.filter((name) => {
    const value = input.env[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  return {
    ok: missing.length === 0,
    missing,
    message:
      missing.length === 0
        ? ''
        : `live check stopped: ${andList(missing)} ${missing.length === 1 ? 'is' : 'are'} not set.` +
          ' Put the missing one in web/.env.local and run again.',
  };
}

/** `a`, `a and b`, `a, b and c`. Reads as a sentence, stays one line. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/** Anything shaped like an Anthropic key, whatever else we were told about. */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]+/g;

/**
 * A string that is safe to print or write to a file.
 *
 * The probe prints the API's own error text, which is the one place an outside
 * string reaches a report. Both the keys we hold and anything key-shaped are
 * replaced, so a body that quoted the request cannot leak one.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    // A blank secret would match everywhere and redact the whole string.
    if (!trimmed || trimmed.length < 8) continue;
    out = out.split(trimmed).join('[redacted]');
  }
  return out.replace(KEY_SHAPE, '[redacted]');
}

// --------------------------------------------------------------------------
// The usage recorder: token counts without touching the splitter
// --------------------------------------------------------------------------

/**
 * A `fetch` that remembers the `usage` block of the reply.
 *
 * `QuestionSplitter.split()` returns the tool input and drops the token
 * counts, which AS2 needs. Rather than change the shared interface for a
 * one-off tool, the script hands the splitter this wrapper as its `fetchImpl`
 * and reads the counts off the recorder afterwards. The splitter stays
 * exactly the file the worker runs.
 *
 * A FAILED response is passed through UNTOUCHED, body unread: the caller's own
 * error path reads it, and reading it here would consume it.
 */
export function createUsageRecorder(inner: typeof fetch): {
  fetch: typeof fetch;
  usage: () => TokenUsage | null;
} {
  let seen: TokenUsage | null = null;

  const wrapped = (async (...args: Parameters<typeof fetch>) => {
    const res = await inner(...args);
    if (!res.ok) return res;

    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      seen = {
        tokensIn: wholeNumber(parsed?.usage?.input_tokens),
        tokensOut: wholeNumber(parsed?.usage?.output_tokens),
      };
    } catch {
      // Not JSON. The caller's own parser will say so; we just lose the count.
      seen = null;
    }

    // A stand-in, not a real `Response`: the body was already consumed, and
    // the only members any caller of ours uses are these five.
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    } as unknown as Response;
  }) as typeof fetch;

  return { fetch: wrapped, usage: () => seen };
}

function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

// --------------------------------------------------------------------------
// The reports
// --------------------------------------------------------------------------

/** `2026-11-07`, from a date, in UTC so two runs never disagree. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `2026-11-07-split-accuracy.md`. Goes under `RESULTS_DIR`. */
export function resultFileName(name: string, date: Date): string {
  return `${isoDate(date)}-${name}.md`;
}

/** A text short enough to read in a report, marked when it was cut. */
export function cut(text: string, limit: number = REPORT_TEXT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : flat.slice(0, limit) + '...';
}

/** `0.02225` as `$0.02225`. Five decimals: one search is $0.01. */
function usd(value: number): string {
  return '$' + value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0');
}

function percent(value: number): string {
  return value.toFixed(1) + ' percent';
}

function numbers(list: readonly number[]): string {
  return list.length === 0 ? 'none' : list.join(', ');
}

export interface SplitReportInput {
  result: SplitComparison;
  paperId: string;
  pdfPath: string;
  model: string;
  usage: TokenUsage;
  cost: Cost;
  date: Date;
}

/** AS2's report. Plain text, so Boss can paste it into `notes.md`. */
export function formatSplitReport(input: SplitReportInput): string {
  const { result } = input;
  const lines: string[] = [
    `# Split accuracy (AS2) -- ${isoDate(input.date)}`,
    '',
    `paper: ${input.paperId}`,
    `pdf: ${input.pdfPath}`,
    `model: ${input.model}`,
    `match threshold: ${result.threshold} similarity on normalised text`,
    '',
    `ground truth in the database: ${result.truthCount} questions`,
    // The official PDFs print question text as pictures, so "how many did it
    // find at all" is a separate number from "how many did it get right".
    `the splitter found ${result.foundCount} questions at all`,
    `RIGHT: ${result.rightCount} of ${result.truthCount} = ${percent(result.accuracy * 100)}` +
      ` (target ${Math.round(result.target * 100)} percent)` +
      ` -- ${result.meetsTarget ? 'MEETS TARGET' : 'BELOW TARGET'}`,
    `wrong: ${result.wrong.length}`,
    `missing numbers: ${numbers(result.missingNumbers)}`,
    `extra numbers: ${numbers(result.extraNumbers)}`,
    `options in the wrong order: ${numbers(result.outOfOrderNumbers)}`,
    '',
    `tokens in: ${input.usage.tokensIn}`,
    `tokens out: ${input.usage.tokensOut}`,
    `cost of this one call: ${usd(input.cost.totalUsd)}`,
    `(${PRICES_WARNING})`,
  ];

  if (result.wrong.length > 0) {
    lines.push('', '## The wrong questions, side by side');
    for (const one of result.wrong) {
      lines.push(
        '',
        `### question ${one.number} (lowest similarity ${one.worstSimilarity.toFixed(4)}` +
          `${one.optionsOutOfOrder ? ', options in the wrong order' : ''})`,
        `stem similarity: ${one.stemSimilarity.toFixed(4)}`,
        `truth stem: ${cut(one.truthStem)}`,
        `found stem: ${cut(one.foundStem)}`,
      );
      one.optionSimilarities.forEach((score, index) => {
        const letter = 'ABCD'[index] ?? String(index + 1);
        lines.push(
          `option ${letter} similarity ${score.toFixed(4)}`,
          `  truth: ${cut(one.truthOptions[index] ?? '(none)')}`,
          `  found: ${cut(one.foundOptions[index] ?? '(none)')}`,
        );
      });
    }
  }

  return lines.join('\n') + '\n';
}

export interface ExplainRun {
  tokensIn: number;
  tokensOut: number;
  searches: number;
  model: string;
  cost: Cost;
  /** The explanation as plain text, so Boss can read what he paid for. */
  text: string;
}

export interface ExplainReportInput {
  questionId: string;
  lang: string;
  runs: readonly ExplainRun[];
  date: Date;
  estimateUsd?: number;
}

/** AS3's report: the measured cost, the estimate, and the gap. */
export function formatExplainReport(input: ExplainReportInput): string {
  const estimate = input.estimateUsd ?? EXPLAIN_COST_ESTIMATE_USD;
  const count = Math.max(input.runs.length, 1);
  const average = {
    tokensIn: input.runs.reduce((sum, one) => sum + one.tokensIn, 0) / count,
    tokensOut: input.runs.reduce((sum, one) => sum + one.tokensOut, 0) / count,
    searches: input.runs.reduce((sum, one) => sum + one.searches, 0) / count,
    totalUsd: input.runs.reduce((sum, one) => sum + one.cost.totalUsd, 0) / count,
  };
  const gap = compareToEstimate(average.totalUsd, estimate);
  const sign = gap.differenceUsd >= 0 ? '+' : '-';

  const lines: string[] = [
    `# Cost of one new explanation (AS3) -- ${isoDate(input.date)}`,
    '',
    `question: ${input.questionId}`,
    `lang: ${input.lang}`,
    `model: ${input.runs[0]?.model ?? 'none'}`,
    `runs: ${input.runs.length}`,
    'NOTHING WAS WRITTEN TO THE DATABASE by this check.',
    '',
  ];

  input.runs.forEach((one, index) => {
    lines.push(
      `run ${index + 1}: tokens_in=${one.tokensIn} tokens_out=${one.tokensOut}` +
        ` searches=${one.searches} cost=${usd(one.cost.totalUsd)}` +
        ` (tokens ${usd(one.cost.inputUsd + one.cost.outputUsd)} + search ${usd(one.cost.searchUsd)})`,
    );
  });

  lines.push(
    '',
    `average: tokens_in=${average.tokensIn.toFixed(0)} tokens_out=${average.tokensOut.toFixed(0)}` +
      ` searches=${average.searches.toFixed(1)} cost=${usd(average.totalUsd)}`,
    `design.md estimate: ${usd(estimate)}`,
    `difference: ${sign}${usd(Math.abs(gap.differenceUsd))} = ${sign}${percent(Math.abs(gap.differencePercent))}`,
    `(${PRICES_WARNING})`,
  );

  input.runs.forEach((one, index) => {
    lines.push('', `## The explanation, run ${index + 1}`, '', one.text.trim());
  });

  return lines.join('\n') + '\n';
}

/**
 * The explanation as plain text, so Boss can read what the call bought.
 *
 * Typed structurally rather than against `@/lib/ai/types`, so this file stays
 * importable by anything without dragging the AI contract in with it. The
 * shape is `ExplanationBody` plus its sources.
 */
export function explanationToText(input: {
  body: {
    exam?: string;
    topic?: string;
    question?: string;
    sections: readonly { heading: string; body: string }[];
    remember?: string;
  };
  sources: readonly { title: string; url: string }[];
}): string {
  const lines: string[] = [
    `Exam: ${input.body.exam || '(none)'}`,
    `Topic: ${input.body.topic || '(none)'}`,
    `Question: ${input.body.question || '(none)'}`,
    '',
  ];
  for (const section of input.body.sections) {
    lines.push(`### ${section.heading}`, section.body, '');
  }
  lines.push(`Remember: ${input.body.remember || '(none)'}`, '', 'Sources:');
  if (input.sources.length === 0) {
    lines.push('- none');
  } else {
    for (const source of input.sources) lines.push(`- ${source.title}: ${source.url}`);
  }
  return lines.join('\n');
}

export interface ProbeReportInput {
  outcome: ProbeOutcome;
  model: string;
  date: Date;
}

/** X7's report: which tool type the API took, and what it said about the rest. */
export function formatProbeReport(input: ProbeReportInput): string {
  const lines: string[] = [
    `# Which web search tool type Haiku accepts (X7) -- ${isoDate(input.date)}`,
    '',
    `model: ${input.model}`,
    '',
  ];

  for (const attempt of input.outcome.attempts) {
    lines.push(
      attempt.accepted
        ? `${attempt.toolType}: ACCEPTED (HTTP ${attempt.status})`
        : `${attempt.toolType}: REJECTED (HTTP ${attempt.status}) -- ${attempt.error ?? 'no error text'}`,
    );
  }

  lines.push('');
  if (input.outcome.willUse) {
    lines.push(
      `The app will use: ${input.outcome.willUse}`,
      'That is the first accepted type in SEARCH_TOOL_TYPES, which is the order',
      'src/lib/ai/anthropic-explainer.ts tries them in. No code change needed.',
    );
  } else {
    lines.push('NO TOOL TYPE WAS ACCEPTED. The app cannot web search as it stands.', '', input.outcome.nextStep ?? '');
  }

  return lines.join('\n') + '\n';
}
