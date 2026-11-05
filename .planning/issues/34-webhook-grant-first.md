---
id: 34-webhook-grant-first
status: done
type: afk
depends_on: []
---
# Security fix: a crash must not leave a paying student locked out

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Razorpay and Supabase are behind small interfaces and faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (this one: `0034_webhook_grant_first.sql`). DB tests use PGlite through `web/test/db.ts`.

This is a SECURITY / MONEY FIX from the 2026-11-05 code review of tickets 26, 27 and 28.

## What is wrong (re-confirm by reading)
- `src/lib/purchases/webhook.ts:388` calls `recordEvent` (RPC `record_payment_event`, `supabase/migrations/0027_ledger.sql:334`). It commits the event id as "seen". Then `:403-422` runs the action (`grant_purchase`, `refund_purchase`, `charge_subscription`, `mark_subscription`) in a SECOND call. `forgetEvent` only runs if the process is still alive to catch the error.
- Scenario: the server is killed (timeout) after `record_payment_event` returned true and before `grant_purchase`. Razorpay retries, the retry is a duplicate, the route returns 200. The student paid and the set stays shut. For `subscription.charged` a month is lost.
- `grant_purchase`, `refund_purchase`, `mark_subscription` are already idempotent through their status checks. `charge_subscription` (`0028_subscriptions.sql:344-394`) is NOT: it adds one month per call.

## Definition of done
1. For purchase events (`payment.captured`/`order.paid`, refunds, subscription status events): run the idempotent action FIRST with no dedupe gate in front of it, then record the event id for audit. A crash between the two is harmless because the retry runs the same idempotent action again.
2. For `subscription.charged`: replace the two calls with ONE SQL function that inserts the dedupe row and applies the charge in a single transaction. The dedupe key is built from the SIGNED body (`charged:<payment.id>`), not from the unsigned `x-razorpay-event-id` header, so replaying a genuine signed body with a new header value cannot add months.
3. A refund that arrives before its capture: `refund_purchase` accepts a purchase in status `created` that has an order attached and moves it to `refunded` (a refund implies a capture). `grant_purchase` already refuses anything not `created`, so a late capture cannot reopen it.
4. `grant_purchase` takes the paid amount (paise) and currency from the signed webhook body and refuses if `amount != amount_inr * 100` or currency is not `INR`. The refusal files a `reconcile_alerts` row and returns 200 (so Razorpay stops retrying). `charge_subscription` checks the Razorpay plan id against the plan the subscription row was opened for, with the same alert-and-200 behaviour.
5. Events that can never succeed (order id over 80 characters, fee over 100000) are stored, alerted and answered with 200, not forgotten with a 500 that retries for hours.

## Vertical slice
- Migration `0034_webhook_grant_first.sql` with the changed/new functions. Keep REVOKE from public/anon/authenticated and GRANT to `service_role` only, `security definer`, `set search_path = public`, like 0027 to 0029.
- `webhook.ts`, `supabase-webhook-store.ts`, `types.ts` and their fakes.

## Test that proves it
Unit tests with the fake store: the action runs before the record call; a crash (fake throws) after the action and before the record leaves the set open and a retry is a harmless no-op. PGlite DB tests: `charge_subscription` twice with the same payment id adds one month only; replay with a different header value adds nothing; refund before capture then late capture leaves status `refunded`, no ledger row, no access; wrong amount or wrong currency files an alert and grants nothing; wrong plan id files an alert. Existing webhook, ledger, subscription and reconcile tests still pass. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Only the webhook ordering, charge idempotency, early refund, amount check, and never-succeed events. Do not change coupon limits, the payout race, or the reconcile job (ticket 35).
