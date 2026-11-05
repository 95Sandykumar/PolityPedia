---
id: 27-razorpay-webhook-ledger
status: todo
type: afk
depends_on: [26-razorpay-order-checkout]
---
# Razorpay webhook: signature, de-dupe, access, teacher ledger

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
When Razorpay says a payment is captured, the set opens for the student and one ledger row records the teacher's and the platform's share. A fake, repeated or out-of-order webhook changes nothing it should not.

## Vertical slice
- Migration `0027_ledger.sql`: `payment_events` (event_id PK, type, payload, received_at), `teacher_ledger` (id, teacher_id, purchase_id UNIQUE, gross, gst, gateway_fee, net, share_pct, teacher_amount, platform_amount, payout_id NULL), `payouts` (id, teacher_id, period, amount, paid_at, reference).
- POST `/api/webhooks/razorpay`: check `X-Razorpay-Signature` (HMAC-SHA256 of the raw body with the webhook secret) FIRST, else 400. Insert the event id; a duplicate returns 200 and does nothing. Reply 2xx fast.
- SQL function `grant_purchase(order_id, fee)`: in one transaction: purchase created -> paid (forward only), `set_access` (valid_until = teacher's next exam date for that exam + 30 days, else 12 months; X2 default), ledger row (gst = gross - gross / 1.18; net = gross - gst - fee; share_pct copied from the teacher at sale time). Refund event: paid -> refunded and the purchase access is removed.

## Test that proves it
`npm test`: bad signature -> 400 and no row; same event twice -> one ledger row; refund before paid does not reopen anything; ledger for Rs 399 at 50% with a test fee is right to the paisa; changing a teacher's share later does not change an old ledger row.

## Design constraints
- A1 idempotency, A2 signature first + de-dupe, A3 forward only, A5 one transaction keyed on purchase id. C: reply fast, no secret in logs. V19 share on mock sets only.

## Notes / scope guard
No payout UI (issue 29).

<!-- ralph 2026-11-05T18:44:34.413Z: upstream 15-mock-sets-authoring blocked -->
