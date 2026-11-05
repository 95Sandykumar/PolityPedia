---
id: 26-razorpay-order-checkout
status: todo
type: afk
depends_on: [16-set-access-mock-list]
---
# Buy a mock set: order with server price, coupon to Rs 0

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student taps 'Unlock Rs 399', a Razorpay order is made with the price from our database, and the Razorpay checkout opens. A 100% coupon opens the set at once without Razorpay.

## Vertical slice
- Migration `0026_purchases.sql`: `purchases` (id, user_id, set_id, razorpay_order_id UNIQUE NULL, amount_inr, coupon, status created/paid/refunded, created_at), `coupons` (code PK, percent_off, max_uses, used).
- `Payments` interface (create order, fetch payments) with a fake. The real one uses Razorpay REST with keys from env (test mode).
- POST `/api/checkout/order` {set_id, coupon?}: the amount comes from `mock_sets`, never from the request. Rs 0 after coupon: `purchases` paid + `set_access` (source purchase) in one transaction, no Razorpay call.
- The Unlock button loads Razorpay checkout.js only on tap.

## Test that proves it
`npm test`: an amount in the request body is ignored; a 100% coupon grants access with no Payments call; an order row has a unique order id; a student cannot read another student's purchases.

## Design constraints
- F-G2: price from our DB. A4: zero-price path reaches access. A1: unique order id.
- Test keys only. Live keys are ticket H5.

## Notes / scope guard
Webhook and ledger are issue 27.

<!-- ralph 2026-11-05T18:44:34.412Z: upstream 15-mock-sets-authoring blocked -->
