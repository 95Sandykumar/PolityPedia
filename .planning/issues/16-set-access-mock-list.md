---
id: 16-set-access-mock-list
status: todo
type: afk
depends_on: [15-mock-sets-authoring]
---
# Set access rules and the student mock list

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student opens a teacher's Mock tests tile and sees each set: price or 'Unlocked', tests with a tick and score when taken, Attempt or Review. Locked sets show a lock and one 'Unlock Rs 399' button (shows 'Payments coming soon' until S5). The free sample test opens for everyone.

## Vertical slice
- Migration `0016_set_access.sql`: `set_access` (user_id, set_id, source purchase/batch/admin, valid_until) PK (user_id, set_id, source). RLS on `questions` for mock questions: readable only with a valid `set_access` row (valid_until > now) or when the test is a free sample.
- Admin page to grant a set to a student (source admin).
- Mock list page: topic dropdown (Full paper default), Practice | Exam switch, rows as described.

## Test that proves it
`npm test`: free sample readable without access; locked test returns 0 questions; admin grant opens it; an expired grant closes it again.

## Design constraints
- design.md RLS: student reads a mock question only with valid set_access or a free sample.

## Notes / scope guard
No purchase flow.
