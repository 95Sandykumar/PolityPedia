---
id: 31-attempt-score-guard
status: todo
type: afk
depends_on: []
---
# Security fix: a student must not be able to write their own score or deadline

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Every outside service is faked in tests. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (this one: `0031_attempt_score_guard.sql`). RLS is on for every table. DB tests use PGlite through `web/test/db.ts`.

This is a SECURITY FIX from the 2026-11-05 code review.

## What is wrong (re-confirm by reading)
`web/supabase/migrations/0013_attempts.sql:100` policy `attempts_update_own` only checks `auth.uid() = user_id` for update. There is no trigger on `attempts` (the reviewer and the author both grepped for one). So a student can send `PATCH /rest/v1/attempts?id=eq.X {"score":999,"submitted_at":"now"}`, set `deadline_at` to the year 2100, or set `submitted_at` to null to reopen a closed exam. The batch report (ticket 20) then shows the forged score to the teacher. Also check `attempt_answers` (`is_correct`) for the same hole.

## Definition of done
A student (role `authenticated`) cannot change `score`, `submitted_at`, `deadline_at`, `mode`, `test_id`, `user_id` on `attempts`, and cannot write `is_correct` on `attempt_answers`, except through the SECURITY DEFINER functions that already own them (`score_attempt()` and the practice marking path). A student cannot insert an attempt with a `score`, a `submitted_at`, or a `deadline_at` they chose. Exam deadlines come from the server.

## Vertical slice
- Migration `0031_attempt_score_guard.sql`: a `before update` (and, where needed, `before insert`) trigger, or column-level privileges, that blocks those columns for `authenticated`/`anon` and allows the definer functions (check `current_user`, as `profiles_block_role_change` in `0002_profiles.sql` does). Follow that existing pattern.
- If app code inserts attempts with a client-chosen `deadline_at`, move it server-side (a column default or the existing start function). Keep the exam screens working.

## Test that proves it
PGlite DB tests with `asUser`: student updates own `score`: refused. Student sets `submitted_at` to null on a submitted sitting: refused. Student moves `deadline_at`: refused. Student inserts an attempt with a score: refused or the score is ignored. `score_attempt()` still marks and closes a sitting. Practice answers still save and mark. A student can still update harmless columns the app needs (check which). User B cannot touch user A's attempt. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Only the attempts and answers tables. Do not touch the answer key (ticket 30) or payments.
