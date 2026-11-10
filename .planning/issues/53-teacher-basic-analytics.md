---
id: 53-teacher-basic-analytics
status: blocked
type: afk
depends_on: [49-subjects-and-topics]
---
# Basic student analytics for teachers

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` section 4. DB tests use PGlite. This ticket owns migration **0048** only. Existing views: `batch_report_tests`, `batch_report_scores` (`0020_batch_reports.sql`), helper `owns_batch()` (`0019_batches.sql`).

## What to build
1. `0048_teacher_stats.sql` (rollback note), security_barrier views, owner-only: `teacher_follower_counts` (teacher sees own count and 7-day change), `batch_activity_7d` (members, active in 7 days, attempts in 7 days), `batch_topic_accuracy` (per topic: answers, percent right; needs ticket 49 tags), `batch_not_attempted` (members with no submitted attempt on a given test). Add index `attempts(test_id, user_id)` if missing.
2. Teacher home: follower count tile (closes the open design call from the UI round), batches tile with active-this-week number.
3. Batch page Insights tab: per test average, top 10, score spread (simple bar list, no chart library), weakest 5 topics, "Not attempted" list with a "Send reminder" button that posts a batch announcement if ticket 52 exists, else copies a message.
4. Empty states that say what will appear and when.

## Test that proves it
PGlite: a teacher cannot read another teacher's batch stats; topic accuracy math on a fixture; not-attempted list excludes submitted members. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No per-student timeline, CSV export, percentile prediction (Upcoming). Do not apply the migration live.

<!-- ralph 2026-11-09T18:51:51.040Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.187Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.318Z: upstream 54-visible-read-errors blocked -->
