---
id: 44-h5-golive-readiness
status: done
type: afk
depends_on: []
---
# Tools for H5: a go-live preflight, a test-purchase verifier, and a runbook

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. Every outside service is behind a small interface and is faked in tests: no real network call, no real key in any test. Env is read lazily inside functions, never at import time, so `npm test` and `npm run build` work with no env set. Jobs live in `web/jobs/` and run with `node --import ./jobs/register-alias.mjs jobs/<file>.ts`.

Human ticket H5 (`.planning/issues/H5-money-go-live.md`): before the first real sale Boss must clear the money gates: X4 (a CA confirms GST and e-commerce TCS), X8 (Adda247 contract check), X1 and X3 confirmed, Razorpay KYC and live keys, Vercel Pro (B9), AS6 (the real Razorpay fee), then start the PM2 apps and prove the money path with one real Rs 299 purchase and a refund. Until then the app uses Razorpay TEST keys only. Both PM2 apps already exist in `ecosystem.config.cjs` (`polity-pdf-split`, `polity-ledger`). Build the tools that make Boss's go-live a short checklist, and make a wrong go-live loud.

## What to build (new files, plus tests)
1. `jobs/golive-check.ts`: a READ-ONLY preflight that prints a table of checks, each `PASS`, `FAIL`, `WARN` or `MANUAL`, and exits non-zero on any `FAIL`. Automatic checks, each with a one-line fix hint when not passing:
   - Razorpay env present (find the exact names with a grep: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, the plan id variables, `RAZORPAY_CHECKOUT_SRC`): which are set (never print a value; show only set or missing).
   - Key MODE: `rzp_test_` prefix is `WARN` "test mode, no real money", `rzp_live_` is `PASS` only when every other money check passes, and a MIX of a test key id with a live secret or the reverse is `FAIL`. Add a `--expect test|live` flag; running with `--expect live` while the keys are test is `FAIL`.
   - The webhook endpoint of the deployed site: an unsigned POST to `<site>/api/webhooks/razorpay` (site from `--site` or `NEXT_PUBLIC_SITE_URL`, default https://politypedia.vercel.app) must answer 4xx and never 5xx; `WARN` if unreachable.
   - Supabase: the service-role key works (one read), `reconcile_alerts` has 0 open rows (list them by kind when not), the latest migration number in `web/supabase/migrations/` is present in `supabase_migrations.schema_migrations` (read it through the Supabase REST API with the service key if that table is exposed, otherwise through `SUPABASE_DB_URL` when set, otherwise `MANUAL` with the one SQL line to run).
   - PM2: `ecosystem.config.cjs` defines `polity-pdf-split` and `polity-ledger`, each with `CLAUDECODE: ''` in its env (design D1), and `npx pm2 jlist` (when pm2 is installed) shows them online, else `MANUAL`.
   - Manual gates read from a file `web/golive.json` (create a template `web/golive.example.json`, and add the real `golive.json` to `web/.gitignore`): X1, X3, X4, X8, B9 (Vercel Pro), AS6 (fee confirmed), Razorpay KYC. Each gate has `done: false`, `by` and `date`. A gate that is not done is `MANUAL` while the site is in test mode and `FAIL` when `--expect live` is set.
2. `jobs/verify-test-purchase.ts <razorpayPaymentIdOrPurchaseId>`: read-only verifier for Boss's Rs 299 test sale and refund. Using the service-role key, find the purchase row and check, with the exact rules the code and migrations already define (read `0026_purchases.sql`, `0027_ledger.sql`, `0029_reconcile.sql`, `0034_webhook_grant_first.sql` and the webhook code under `src/lib/purchases/`): purchase is `paid` with `amount_inr` 299 (or the amount you pass with `--amount`), exactly one `teacher_ledger` row exists with the revenue share copied at sale time and the right split of the amount, the buyer's access (`set_access` or entitlement) exists and ends where the product rules say, the `payment_events` row exists once, there is no open `reconcile_alerts` row for it. With `--refunded` it checks what the code does on a refund (find it; if the app has NO refund handling yet, say so plainly as a `FAIL` named "refund path not built" and describe in the output the smallest follow-up ticket). Print a table with PASS/FAIL per check and the raw numbers.
3. `web/GO-LIVE.md`: the runbook in plain English, in order: gates to clear (with who and what for each of X1, X3, X4, X8, B9, AS6, KYC), env to change in Vercel (names only), how to run `golive-check` with `--expect test` now and `--expect live` on the day, how to make the one Rs 299 purchase and refund, how to run the verifier, how to start both PM2 apps and read their logs, how to roll back to test keys in one step, and a "never do" list.
4. Pure check logic (mode detection, table formatting, rules) in `src/lib/golive/` with tests; the two scripts are thin wrappers with an injectable fetch. No edits to webhook, ledger or purchase logic.

## Test that proves it
Unit tests with fake fetch and fake rows, no network: key mode detection for test, live, mixed and missing; `--expect live` turns test keys and any undone manual gate into FAIL while `--expect test` does not; the webhook check passes on 400 and fails on 500; the open-alert and migration-number checks; PM2 config check; the verifier passes a correct fixture purchase, and fails each of: wrong amount, two ledger rows, missing access, duplicate event row, open alert; a missing env gives a clear one-line message and a non-zero exit with no stack trace and no key in the output. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not edit `package.json`, `i18n.ts`, any migration, `ecosystem.config.cjs` (except nothing needs changing there), or the webhook, ledger, purchase and refund logic. Never print or log a key or a payment secret. Do not call Razorpay or Supabase in any test.

<!-- 2026-11-08: merged by hand into merge/night-0708 after a reviewer PR review; .gitignore conflict resolved by keeping all blocks -->
