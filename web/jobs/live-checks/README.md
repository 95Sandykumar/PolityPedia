# Live AI checks (ticket H3)

Three tools. One command each. Each one prints a plain report and saves it.

They turn the three estimates in `design.md` into measured numbers:

| Number | Tool | What design.md guesses |
|---|---|---|
| AS2, split accuracy | `split-accuracy.ts` | 80 percent target, never measured |
| AS3, cost of one new explanation | `explain-cost.ts` | $0.022 |
| X7, which web search tool type Haiku takes | `search-probe.ts` | unknown, two candidates |

## Before you start

1. Put `ANTHROPIC_API_KEY` in `web/.env.local`. It spends money, so it is
   server only and never has a `NEXT_PUBLIC_` prefix.
2. `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` have to be in
   there too, for the two tools that read the database.
3. Run everything from inside `web/`.

A missing key is ONE line and exit code 1. No stack trace, and no key is ever
printed, logged or written to a report.

Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning when it runs any of these.
Ignore it. The existing `jobs/pdf-split.ts` worker prints the same one, for the
same reason: `web/package.json` belongs to Next.js and has no `"type"` field.

## Run them in this order

Cheapest question first, most expensive last.

### 1. Which web search tool type works (X7)

```
cd web
node --import ./jobs/register-alias.mjs jobs/live-checks/search-probe.ts
```

Sends one tiny request per tool type in `SEARCH_TOOL_TYPES`
(`src/lib/ai/anthropic-explainer.ts`). Costs a few input tokens.

Prints: each type as ACCEPTED or REJECTED with its HTTP status and the API's
own error text, then which type the app will use (the first accepted one). If
neither is accepted it says so and names the first thing to try next.

Needs: `ANTHROPIC_API_KEY` only.

### 2. Cost of one new explanation (AS3)

```
cd web
node --import ./jobs/register-alias.mjs jobs/live-checks/explain-cost.ts \
  <questionId> --lang en --runs 1
```

`<questionId>` is a `questions.id` uuid. Pick any live question that has an
answer key.

Flags: `--lang en|hi` (default `en`), `--runs N` (default 1, max 5; the average
is printed).

Prints: `tokens_in`, `tokens_out`, `searches`, the dollar cost, the $0.022
estimate, the difference in percent, and the explanation text so you can read
what the money bought.

Costs: one real Haiku call WITH WEB SEARCH per run. Search is about 90 percent
of it, which is why `--runs` is capped at 5.

**It writes nothing to the database.** No `ai_explanations` row, no
student's 30-a-day spent.

### 3. Split accuracy (AS2)

```
cd web
node --import ./jobs/register-alias.mjs jobs/live-checks/split-accuracy.ts \
  papers-import/cuetpg/pdfs/<paper>.pdf --paper <databasePaperId>
```

Two arguments that have to MATCH each other: the local PDF, and the `papers.id`
uuid of the proofread copy of that same paper in the database. The database
rows are the ground truth; the PDF is what the splitter reads. Point it at the
wrong pair and the accuracy number is meaningless.

The PDF path can be absolute, or relative to `web/`. The six proofread official
past papers live under `web/papers-import/cuetpg/pdfs/` and
`web/papers-import/ugcnet/pdfs/`.

Flag: `--threshold 0.97` (default), the similarity two normalised texts need to
count as the same.

Prints:

- how many questions the database holds, and how many the splitter found AT ALL
  (the official PDFs print question text as pictures, so a found count of 0 is a
  picture problem, not an accuracy problem);
- RIGHT as a count and a percent, against the 80 percent target;
- the wrong questions with both texts side by side, cut to 200 characters, and
  the raw similarity of each, so a near miss at 0.96 reads as "almost";
- the numbers that are missing, the numbers that are extra, and the questions
  whose four options came back in the wrong order;
- `tokens in`, `tokens out` and the dollar cost of the one call;
- what the real worker would have done with the same answer.

Costs: one real Haiku call on a whole PDF. Can take minutes. **It writes
nothing to the database.**

## Where the reports go

```
web/live-checks/results/<YYYY-MM-DD>-<name>.md
```

`split-accuracy`, `explain-cost`, `search-probe`. The folder is gitignored
except its `.gitkeep`, so a report never lands in a commit. The report is also
printed to the terminal.

These tools never touch the repo root `notes.md`. That page is yours.

## The two manual steps

These are the parts no tool can do for you.

1. **Set a monthly spend alert in the Anthropic console.** Console → Settings →
   Limits (or Billing) → set a monthly spend cap and an email alert. Do this
   BEFORE step 2 or 3, because those are the two commands that spend money.
2. **Paste the numbers into `notes.md`** at the repo root, under H3. Copy the
   three lines that matter: split accuracy percent, measured cost of one
   explanation, and the accepted web search tool type. That is what closes the
   ticket.

## When a price looks wrong

Every dollar figure comes from one file:

```
web/src/lib/live-checks/prices.ts
```

Every number in it is marked UNVERIFIED and dated, because they came from
`design.md`, which took them from a cached skill page. Check them against the
Anthropic pricing page, edit that one file, and re-run. No other file has a
price in it.

## What is tested, and what is not

The maths is pure and unit tested with fake data in
`src/lib/live-checks/__tests__/`: the comparison, the similarity number, the
cost maths, the probe verdict, the report text and the "key is missing" line.
No test makes a network call, holds a real key or spends a token.

The three scripts here are thin wrappers: they read env lazily, call `fetch`
through an injectable function, and print what the pure functions return. The
live run against the real API is ticket H3, which is yours.
