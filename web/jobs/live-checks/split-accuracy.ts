/**
 * AS2: how much of a real past paper the splitter gets right
 * (issue 42-h3-live-check-tools, ticket H3).
 *
 * It runs THE REAL SPLITTER on a local PDF, then compares what came back with
 * the proofread questions already in the database for that paper, and prints
 * the percentage against the 80 percent target.
 *
 *   cd web
 *   node --import ./jobs/register-alias.mjs jobs/live-checks/split-accuracy.ts \
 *     papers-import/cuetpg/pdfs/<paper>.pdf --paper <databasePaperId>
 *
 * IT SPENDS MONEY: one real Haiku call on a whole PDF. One run, one call.
 *
 * IT WRITES NOTHING TO THE DATABASE. It reads the ground truth and that is
 * all. The report goes to `web/live-checks/results/<date>-split-accuracy.md`.
 *
 * WHY THE SPLITTER IS NOT COPIED HERE. `createHaikuSplitter` is the file the
 * PM2 worker runs, with the same prompt, the same tool schema and the same
 * model pin, so the number this prints is the number the app will get. The
 * token counts the splitter does not return are read by wrapping its
 * `fetchImpl` with `createUsageRecorder`, which leaves that shared file
 * untouched.
 *
 * NOTE ON THE OFFICIAL PDFs: they print the question text as pictures, so
 * "how many questions it found at all" is reported separately from "how many
 * it got right". A found count of 0 is a picture problem, not an accuracy one.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  alignByStem,
  compareSplit,
  createUsageRecorder,
  formatSplitReport,
  tokenCostUsd,
  type CheckQuestion,
} from '@/lib/live-checks/core';
import { SPLIT_MATCH_THRESHOLD } from '@/lib/live-checks/prices';
import { createHaikuSplitter } from '@/lib/split/haiku-splitter';
import { MAX_QUESTIONS_PER_PAPER, SPLIT_MODEL, readSplitAnswer } from '@/lib/split/types';
import { readPaperQuestions } from './rest';
import {
  WEB_ROOT,
  flagText,
  isEntryPoint,
  publish,
  readArgs,
  requireEnv,
  requireUuid,
  run,
  stop,
} from './shared';

const USAGE =
  'Usage: node --import ./jobs/register-alias.mjs jobs/live-checks/split-accuracy.ts ' +
  '<pdf-path> --paper <databasePaperId> [--threshold 0.97]';

/**
 * Every question the model returned, numbered BY POSITION, dropping only the
 * ones with no readable stem or options.
 *
 * Deliberately looser than `readSplitAnswer`, which refuses the WHOLE answer
 * when one question is malformed. That is the right call for the worker (a
 * silently skipped question is a gap a teacher cannot see) and the wrong call
 * for a measuring tool: Boss still wants the accuracy of the 49 good ones.
 * The strict reader's verdict is printed next to the number, so the report
 * says both things.
 */
export function looseQuestions(answer: unknown): CheckQuestion[] {
  const raw = (answer as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];

  const out: CheckQuestion[] = [];
  raw.forEach((one, index) => {
    if (typeof one !== 'object' || one === null) return;
    const row = one as { stem?: unknown; options?: unknown };
    const stem = typeof row.stem === 'string' ? row.stem : '';
    const options = Array.isArray(row.options)
      ? row.options.filter((option): option is string => typeof option === 'string')
      : [];
    if (stem.trim().length === 0 || options.length === 0) return;
    // The schema has no number field, so position is the number: the model is
    // told to return the questions "in the order they appear".
    out.push({ number: index + 1, stem, options });
  });
  return out;
}

/** The PDF bytes, or stop with one line. */
async function readPdf(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return stop(`live check stopped: cannot read the PDF at ${path}.`);
  }
}

export async function main(): Promise<void> {
  const args = readArgs();
  requireEnv(['ANTHROPIC_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

  const pdfArg = args.positional[0];
  if (!pdfArg) stop('live check stopped: no PDF path. ' + USAGE);
  const pdfPath = isAbsolute(pdfArg) ? pdfArg : join(WEB_ROOT, pdfArg);
  const paperId = requireUuid(flagText(args, 'paper', USAGE), 'the paper id');

  const thresholdFlag = args.flags.threshold;
  const threshold = typeof thresholdFlag === 'string' ? Number(thresholdFlag) : SPLIT_MATCH_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    stop('live check stopped: --threshold must be a number from 0 to 1.');
  }

  const pdf = await readPdf(pdfPath);

  // The ground truth FIRST, before a single token is spent: a paper with no
  // proofread questions makes the whole run pointless.
  const truth = await readPaperQuestions(paperId);
  if (truth.length === 0) {
    stop(
      `live check stopped: the database has no questions for paper ${paperId}, ` +
        'so there is no ground truth to compare against. Nothing was sent to Claude.',
    );
  }

  console.log(
    `[split-accuracy] ground truth: ${truth.length} questions. ` +
      `Calling ${SPLIT_MODEL} once on ${pdfPath}. This can take minutes.`,
  );

  const recorder = createUsageRecorder(fetch);
  const splitter = createHaikuSplitter({ fetchImpl: recorder.fetch });
  const answer = await splitter.split({ pdf, maxQuestions: MAX_QUESTIONS_PER_PAPER });

  const strict = readSplitAnswer(answer);
  const found = looseQuestions(answer);
  const usage = recorder.usage() ?? { tokensIn: 0, tokensOut: 0 };
  const date = new Date();

  // Pair by stem, not position: one dropped question must not shift and fail
  // every question after it (the splitter schema has no number field).
  const alignment = alignByStem(truth, found);
  const scored = compareSplit({ truth, found: alignment.aligned, threshold });
  // Scored on the paired questions, but the report's "found at all" and
  // "extra" lines must still describe the splitter's whole answer.
  const paired = new Set(alignment.pairedFoundNumbers);
  const result = {
    ...scored,
    foundCount: found.length,
    extraNumbers: found.filter((one) => !paired.has(one.number)).map((one) => one.number),
  };
  const report =
    formatSplitReport({
      result,
      paperId,
      pdfPath,
      model: SPLIT_MODEL,
      usage,
      // The split request carries no web search tool, so there is no search to
      // pay for: the whole cost is tokens.
      cost: tokenCostUsd({ model: SPLIT_MODEL, ...usage, searches: 0 }),
      date,
    }) +
    '\n' +
    [
      '## Pairing by stem',
      '',
      alignment.renumbered === 0 && alignment.unpaired === 0
        ? 'Every found question paired with the question at its own position. No shift.'
        : `${alignment.renumbered} found questions were paired with a different number than their ` +
          `position (the splitter dropped or merged a question before them). ${alignment.unpaired} ` +
          'found questions paired with no database question and are left out of the score.',
      '',
    ].join('\n') +
    // What the WORKER would have done with this same answer. A strict refusal
    // next to a good accuracy number means one malformed question cost the
    // whole paper, which is a different fix from a bad split.
    '\n' +
    [
      '## What the worker would have done with this answer',
      '',
      strict.ok
        ? `readSplitAnswer accepted it: ${strict.questions.length} questions would have been written as drafts.`
        : `readSplitAnswer REFUSED the whole answer: reason "${strict.reason}". The worker would ` +
          'have retried. The accuracy above is measured on the readable questions anyway.',
      '',
    ].join('\n');

  await publish({ name: 'split-accuracy', report, date });
}

if (isEntryPoint('split-accuracy')) run(main);
