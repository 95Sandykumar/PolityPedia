---
id: 02-db-harness
status: todo
type: afk
depends_on: [01-app-shell]
---
# Database test harness (PGlite) + profiles table with RLS

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
Ralph and every later slice can prove database rules in tests. A signed-in user can read and edit only their own profile, and cannot change their own role.

## Vertical slice
- Migration `0002_profiles.sql`: `profiles` (id uuid PK, role student/teacher/admin default student, display_name, lang en/hi/both default en, created_at). RLS: select/update own row only. A trigger or check stops a non-admin from changing `role`.
- Test helper `web/test/db.ts`: starts PGlite, creates a stub of what Supabase gives (schema `auth`, table `auth.users`, function `auth.uid()` reading `request.jwt.claim.sub`, roles `anon` and `authenticated`), applies every file in `web/supabase/migrations/` in name order, and offers `asUser(id, fn)` that runs queries with role `authenticated` and that user's id.
- Write a short section in `web/CLAUDE.md` on how to use the helper.

## Test that proves it
`npm test`: (1) user A reads own profile = 1 row; (2) user A reads user B's profile = 0 rows; (3) user A cannot set own role to admin; (4) a guard test proves RLS is really enforced under `asUser` (a table with RLS and no policy returns 0 rows).

## Design constraints
- Single source of truth: Supabase Postgres owns all app data. RLS on every table (design.md 3).
- If PGlite cannot enforce RLS with SET ROLE, stop and mark this issue blocked with the reason. Do not fake RLS in JS.

## Notes / scope guard
Only the harness and `profiles`. No sign-in UI.
