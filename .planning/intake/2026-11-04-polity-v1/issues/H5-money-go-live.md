---
id: H5-money-go-live
status: todo
type: human
depends_on: [27-razorpay-webhook-ledger, 28-plan-subscriptions, 29-ledger-reconcile-payouts]
---
# Boss: clear the money gates before the first real sale

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
Real payments can be switched on safely.

## Vertical slice
- X4: CA confirms GST and e-commerce TCS. X8: Adda247 contract check. X1 and X3 confirmed. Razorpay KYC + live keys. Vercel Pro (B9). AS6: real Razorpay fee.
- Start the PM2 apps `polity-pdf-split` and `polity-ledger`.

## Test that proves it
One real Rs 299 test purchase, then a refund; ledger row and reconcile both right.

## Design constraints
- B9, X1, X3, X4, X8, A6.

## Notes / scope guard
Until this is done, the app uses Razorpay test keys only.
