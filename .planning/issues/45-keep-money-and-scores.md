---
id: 45-keep-money-and-scores
status: done
type: afk
depends_on: []
---
# Deleting a mock set, test, paper or batch must never erase payments or scores

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Design for this batch of work: `.planning/intake/2026-11-06-teacher-v1.1/design.md` (sections 4 and 5). DB tests use PGlite (`web/test`). All outside services are faked in tests. Env is read lazily, never at import time. Migrations are in `web/supabase/migrations`; the last one is `0040_ai_finish_server_only.sql`. This ticket owns migration number **0041** only.

## The bug (verified)
`0026_purchases.sql:113`: `purchases.set_id ... references public.mock_sets (id) on delete cascade`. A teacher deleting a mock set (`mock_sets_delete_own` policy, `DELETE /api/teacher/mock-sets/[setId]`) erases payment rows, `set_access` rows (paid students lose access) and, through `mock_tests -> attempts`, every student score. `0013_attempts.sql:43` does the same for papers.

## What to build
1. `0041_keep_money_and_scores.sql` with a rollback note at the top:
   - `purchases.set_id` FK -> `on delete restrict`. Check `ledger` and any other money table for the same cascade and restrict it too (list what you changed in the migration header).
   - `archived_at timestamptz` on `mock_sets`, `mock_tests`, `papers`, `batches`.
   - Student-facing RLS/select policies: archived rows are hidden from browse lists, but a student who holds `set_access` for the set, or has an attempt, can still open it and see old results.
   - Drop the teacher DELETE policies on `mock_sets`, `mock_tests`, `papers`, `batches`. Replace with SECURITY INVOKER RPCs `remove_mock_set(id)`, `remove_mock_test(id)`, `remove_paper(id)`, `remove_batch(id)`, `restore_*(id)`: hard delete only when no purchase, no `set_access`, no attempt and (batch) no member ever; otherwise set `archived_at = now()`. Return `'deleted'` or `'archived'`. Restore allowed within 30 days.
   - Archiving a batch removes batch-sourced `set_access` through the existing sync trigger path (do not leave stale grants), keeps `batch_report_*` readable for the teacher.
2. API routes that delete these objects call the RPCs and return `{ result: 'deleted' | 'archived' }`. Teacher UI: the Delete button shows the result in a toast ("Archived. Students who paid keep access. Restore within 30 days."), and the list gets an "Archived" filter with a Restore button.
3. New attempts cannot start on an archived test (`/api/tests/[id]/load` refuses with a clear message).

## Test that proves it
PGlite tests: (a) a set with a purchase -> remove returns `archived`, the purchase row and set_access remain, the buyer can still load results; (b) an empty draft set -> `deleted`, rows gone; (c) direct `delete from purchases`-path via set delete is refused by the FK; (d) a stranger cannot remove or restore someone else's set; (e) restore after 31 days refused; (f) archived test refuses a new attempt. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No change to scoring, payment or webhook logic. Do not apply the migration to the live database. Do not edit migrations 0002 to 0040.
