---
id: 19-batches
status: todo
type: afk
depends_on: [16-set-access-mock-list]
---
# Batches: create, join by link or code, free sets

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher creates batches, shares a join link or code, sees and removes students, and picks which mock sets the batch gets free. A student can join many batches. A removed student loses the batch access.

## Vertical slice
- Migration `0019_batches.sql`: `batches` (id, teacher_id, name, join_code UNIQUE, created_at), `batch_members` (batch_id, user_id, joined_at) PK both, `batch_sets` (batch_id, set_id) PK both. Access with source batch is kept in step with members and sets (trigger or view), and removed on leave.
- Teacher Batches pages: list with student count + copy link, batch page (code, students, sets). Student `/join/[code]` page.

## Test that proves it
`npm test`: one student in 2 batches; joining grants the batch's sets; removal revokes them; teacher B cannot see teacher A's batches; a bad code shows a clear error.

## Design constraints
- V2, V3: many-to-many, join by link or code, teacher picks sets.

## Notes / scope guard
Reports are issue 20.

<!-- ralph 2026-11-05T18:44:34.417Z: upstream 15-mock-sets-authoring blocked -->
