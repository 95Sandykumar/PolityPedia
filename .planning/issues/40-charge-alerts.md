---
id: 40-charge-alerts
status: todo
type: afk
depends_on: []
---
# Fix: a paid subscription charge that is dropped must file an alert

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. SQL migrations live in `web/supabase/migrations/`. Name yours `0039_charge_alerts.sql` (0038 is the last one). DB tests use PGlite through `web/test/db.ts`. Labels are English and Hindi in `web/src/lib/i18n.ts`.

A reviewer found this (finding #10, LOW).

## What is wrong (re-confirm with a failing test FIRST)
`public.charge_subscription()` (`0034_webhook_grant_first.sql`, about lines 417-520) inserts the de-dupe row into `payment_events` FIRST, then returns FALSE with no alert when:
- the subscription id is unknown (`if not found then return false`), or
- the subscription is `cancelled` (`A3`).
Only the plan mismatch files a `reconcile_alerts` row. Because the de-dupe row is already committed, a Razorpay retry of the same payment id is dropped as "already seen". Result: money was taken, no month was granted, and nothing tells a human. The unknown case is also real in a race where the `charged` webhook lands before our own subscription row is written.

## Definition of done
1. New alert kinds `unknown_subscription` and `cancelled_subscription`. Migration `0039_charge_alerts.sql` widens `reconcile_alerts_kind_check` (keep ALL 8 existing kinds from 0035: `no_purchase, not_paid, amount_mismatch, no_payment, currency_mismatch, plan_mismatch, bad_event, unreadable_purchase`) and updates the column comment.
2. `charge_subscription()` files `record_reconcile_alert(...)` with the new kind, using the same subject style as the plan mismatch (`left(case when key = '' then 'sub:' || wanted else key end, 160)`), then returns FALSE, in both branches. It still never raises for these, so the webhook still answers 2xx. The alert is idempotent on `(kind, subject)`.
3. Month logic is unchanged: no month is added in either branch, a repeat is still FALSE, and a normal charge still adds exactly one month.
4. TypeScript: add both kinds to `ReconcileKind` (`src/lib/ledger/types.ts`), to `KINDS` in `src/lib/ledger/supabase-alerts-client.ts`, and to English and Hindi labels, plus any `Record<ReconcileKind, ...>`, so `/admin/alerts` shows them and the badge counts them.

## Test that proves it
PGlite tests (each failing before the fix): a charge for an unknown subscription id files exactly one `unknown_subscription` alert, adds no month, and a second delivery of the same key files no second alert; a charge for a cancelled subscription files `cancelled_subscription` and adds no month; a normal charge and a plan-mismatch charge behave as before (existing tests pass); the check constraint still accepts all 8 old kinds. Unit tests: both new kinds render in English and Hindi on the alerts list and count in the badge. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not move the de-dupe insert, do not change refunds, claims, exam locks or sessions, and do not add a service key to the app.
