---
id: 21-plans-entitlements
status: todo
type: afk
depends_on: [03-sign-in]
---
# Plans and entitlements (AI Rs 100, Pro Rs 500) with can_use()

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
An admin can give a student the AI plan or Pro for testing. The app asks one function, `can_use(user, feature)`, to decide who gets AI, notes and score analysis.

## Vertical slice
- Migration `0021_entitlements.sql`: `entitlements` (user_id, plan ai/pro, valid_until, source admin/razorpay) PK (user_id, plan). SQL function `can_use(user_id, feature)`: `ai` true for a valid ai or pro row; `notes` and `analysis` true for pro only.
- Admin page to grant or end a plan.

## Test that proves it
`npm test`: ai plan -> can_use ai true, notes false; pro -> both true; expired -> false; a student cannot insert own entitlement.

## Design constraints
- V18 plans. X6 default: Pro has the same 30/day AI cap.

## Notes / scope guard
No payments.
