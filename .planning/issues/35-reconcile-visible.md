---
id: 35-reconcile-visible
status: todo
type: afk
depends_on: []
---
# Fix: the nightly money check must be able to reach a human

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Razorpay and Supabase are behind small interfaces and faked in tests. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (this one, if needed: `0035_reconcile_visible.sql`). DB tests use PGlite through `web/test/db.ts`. Labels exist in English and Hindi in `web/src/lib/i18n.ts`.

This is a MONEY FIX from the 2026-11-05 code review of ticket 29-ledger-reconcile-payouts.

## What is wrong (re-confirm by reading)
- The nightly job `web/jobs/ledger-reconcile.ts` (~lines 83-89, header ~line 36) is the backstop that finds lost payment webhooks. Nothing outside the job reads the `reconcile_alerts` table: there is no admin page and no push message.
- If any key is missing the job logs "not configured" and exits 0. PM2 treats exit 0 as success (`stop_exit_codes [0]`), so a rotated or missing Razorpay key means every night checks nothing and looks fine.
- `src/lib/ledger/supabase-reconcile-store.ts:149-167`: the purchases read is silently capped at 2000 while its comment says reaching the cap is an error. `src/lib/purchases/razorpay-payments.ts:347-358` drops unreadable captured payment rows silently.
- `src/lib/ledger/reconcile.ts:76-81`: `listPayments` returns every payment in the account, including subscription charges, whose order id is Razorpay's own and never in `purchases`. Each monthly plan charge would file a false `no_purchase` alert. (Unverified against live Razorpay: treat a payment with an `invoice_id` or a subscription link as a subscription payment and skip it, and keep the fake payload shape in the types.)

## Definition of done
1. The job exits with a non-zero code when it could not check (not configured, Razorpay or Supabase read failed, cap reached). Exit 0 only after a real check.
2. Reading `purchases` throws when the result length equals the cap. Rows that cannot be read are counted, and a non-zero count files an alert.
3. Subscription payments are skipped by the "no purchase" check (see above).
4. Admin page `/admin/alerts` (follow the existing admin pages and guard from tickets 05 and 21): a bilingual list of unresolved `reconcile_alerts` rows (when, kind, payment id, amount, detail) with a "Resolved" button that sets the resolved time. Admin only, enforced by RLS and the route guard. The Admin home links to it and shows the count of open alerts.
5. When the job files a new alert it also tries one Telegram message to the bot's existing admin notify path if the repo already has one for jobs (look at how other `jobs/*.ts` notify). If the repo has no such path, skip this item and say so in the commit message. Never fail the job because the message failed.

## Vertical slice
- Job, store, reconcile logic, Razorpay payments list changes.
- Migration only if `reconcile_alerts` lacks a resolved column or an admin update policy.
- Admin alerts page and its tests.

## Test that proves it
Unit tests with fakes: missing keys give a non-zero exit code; a failed Razorpay read gives a non-zero exit code; a 2000-row result throws; a subscription payment does not raise `no_purchase`; a normal payment with no purchase still does. DB tests: admin lists and resolves alerts; a student and a teacher cannot read or resolve them. Page test: the list renders in both languages and the resolve button calls the store once. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not change the webhook ordering (ticket 34), coupon limits or the payout race.
