---
id: 28-plan-subscriptions
status: blocked
type: afk
depends_on: [27-razorpay-webhook-ledger, 21-plans-entitlements]
---
# AI plan and Pro subscriptions through Razorpay

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student opens Me > Plans, picks the AI plan (Rs 100/month) or Pro (Rs 500/month), pays through Razorpay, and gets access. When the subscription stops, access ends at the paid-until date.

## Vertical slice
- Plan page on the Me tab. The `Payments` interface gains create subscription (fake in tests).
- The webhook from issue 27 handles subscription events (activated, charged, cancelled, halted) -> `entitlements` (source razorpay, valid_until). Same signature + de-dupe rules.
- No teacher share on plan money (V19).

## Test that proves it
`npm test`: charged event extends valid_until; cancelled keeps access until valid_until; a replayed charged event does not extend twice; no ledger row for plan money.

## Design constraints
- A1 to A3 as issue 27. V18, V19.

## Notes / scope guard
No proration, no plan switching mid-cycle.

<!-- ralph 2026-11-05T18:44:34.416Z: upstream 15-mock-sets-authoring blocked -->
