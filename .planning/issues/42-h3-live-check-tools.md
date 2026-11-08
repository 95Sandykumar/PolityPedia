---
id: 42-h3-live-check-tools
status: done
type: afk
depends_on: []
---
# Tools for H3: run the live AI checks with one command each

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. Every outside service is behind a small interface and is faked in tests: no real network call, no real key in any test. Env is read lazily inside functions, never at import time, so `npm test` and `npm run build` work with no env set. Jobs live in `web/jobs/` and run with `node --import ./jobs/register-alias.mjs jobs/<file>.ts` (see `jobs/pdf-split.ts` and `ecosystem.config.cjs`).

Human ticket H3 (`.planning/issues/H3-ai-live-checks.md`) needs Boss to measure three real numbers with the real Claude API: split accuracy (AS2, target 80 percent), the cost of one new explanation (AS3, estimate 0.022 US dollars), and which web search tool version Haiku 5.5 accepts (X7). Build the tools so Boss runs one command per number and gets a plain report. Boss supplies `ANTHROPIC_API_KEY` in `web/.env.local` later; you never need it.

## What to build (new files only, under `web/jobs/live-checks/`, plus tests)
1. `split-accuracy.ts <pdf-path> --paper <databasePaperId>`: run the real splitter (`src/lib/split/haiku-splitter.ts`, same prompt and tool as the worker) on a local PDF, then compare its questions with the GROUND TRUTH already in the database for that paper (the database now holds six proofread official past papers: ask Boss to point it at the matching PDF in `web/papers-import/cuetpg/pdfs/` or `web/papers-import/ugcnet/pdfs/`). Read the truth rows with the service-role key through the REST API (use the pattern in `src/lib/split/env.ts` for the lazy env). Match by question number; count a question as RIGHT only when the stem and all four options match after whitespace, case, quote and dash normalisation (use a similarity threshold of 0.97 on a normalised string, and report the raw similarity so Boss can see near misses); also report numbers missing, extra, and options in the wrong order. Print a plain summary: percent right against the 80 percent target, the list of wrong questions with the two texts side by side (cut to 200 chars), the input and output token counts and the dollar cost of the call from the price table below. Note: the official PDFs print question text as pictures, so also report how many questions the splitter found at all.
2. `explain-cost.ts <questionId> [--lang en|hi]`: build the explanation prompt and call the real explainer exactly as the app does (`src/lib/ai/anthropic-explainer.ts`, `prompt.ts`), but do NOT write to the database. Print `tokens_in`, `tokens_out`, `searches`, the dollar cost from the price table, the 0.022 estimate, the difference in percent, and the explanation text (so Boss can read it). Support `--runs N` (default 1, max 5) and print the average.
3. `search-probe.ts`: send one tiny real request to the model `claude-haiku-5-5` for each tool type in `SEARCH_TOOL_TYPES` (`web_search_20260209`, `web_search_20250305`; read the constant from `anthropic-explainer.ts`) and report which ones the API accepts, the HTTP status and error text of the rejected ones, and which one the app will end up using (the first accepted). If neither is accepted, say so clearly and name the first thing to try next.
4. A small price table file `jobs/live-checks/prices.ts` with per-million-token input and output prices for the models used and the per-search price, each with a comment "UNVERIFIED, check the Anthropic pricing page" and the date; all cost maths imports from it, so Boss edits one place.
5. `jobs/live-checks/README.md`: the exact commands Boss runs, in order, what each prints, where the report is saved, and the two manual steps (set a monthly spend alert in the Anthropic console; paste the numbers into `notes.md`). Each run also writes its plain report to `web/live-checks/results/<YYYY-MM-DD>-<name>.md` (create the folder with a `.gitkeep`; add that results folder to `web/.gitignore` except `.gitkeep`). Never write into the repo root `notes.md`.
6. Core logic (matching, similarity, cost maths, report formatting) as pure functions in `jobs/live-checks/core.ts` (or `src/lib/live-checks/`) so the tests cover them with fake data; the three scripts are thin wrappers that read env lazily and call fetch through an injectable function.

## Test that proves it
Unit tests with fake fetch and fake rows, no network: the comparison counts right, wrong, missing and extra questions correctly on a small fixture including a near miss at 0.96 and 0.98 similarity; the cost maths gives the expected dollars from known token counts; the probe reports the first accepted tool type when the first is rejected with a 400 and the second accepted, and reports the "none accepted" case; a missing `ANTHROPIC_API_KEY` or service key gives a clear one-line message and a non-zero exit, never a stack trace and never a printed key. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not edit `package.json`, `i18n.ts`, any migration, or any existing source file except to add exports that are strictly needed (say which). Never print or log a key. Do not call the real API in any test.

<!-- 2026-11-08: merged by hand into merge/night-0708 after a reviewer PR review; .gitignore conflict resolved by keeping all blocks -->
