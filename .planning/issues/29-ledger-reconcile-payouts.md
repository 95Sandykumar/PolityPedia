---
id: 29-ledger-reconcile-payouts
status: blocked
type: afk
depends_on: [27-razorpay-webhook-ledger]
---
# P10 nightly reconcile and payout report

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
Every night a job compares Razorpay payments with our purchases and records any mismatch for Boss. An admin sees, per teacher and month, what is owed, and marks a payout as paid.

## Vertical slice
- `web/jobs/ledger-reconcile.ts`: payments of the last 48 hours through `Payments` vs `purchases`; each mismatch -> a row in `reconcile_alerts` (migration `0029_reconcile.sql`) and a log line. Safe to run twice.
- Add app `polity-ledger` to `web/ecosystem.config.cjs`: cron 2 AM CST, `CLAUDECODE: ''`, `stop_exit_codes: [0]`. Do NOT start it.
- Admin payout page: unpaid ledger sum per teacher per month, Mark paid -> `payouts` row and ledger rows linked.

## Test that proves it
`npm test` with a fake Payments: a payment with no purchase -> 1 alert; running twice -> still 1 alert; mark paid links ledger rows and they leave the unpaid sum.

## Design constraints
- A6 reconcile. D1, D2, D4, D5, D6. X1 default: monthly manual bank transfer.

## Notes / scope guard
No Telegram alert wiring (ClaudeClaw side, later).

<!-- ralph 2026-11-05T18:44:34.414Z: upstream 15-mock-sets-authoring blocked -->
