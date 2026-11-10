---
id: 56a-result-reader
status: done
type: afk
depends_on: []
---
# Result reader for a submitted attempt (service and tests only, no screens)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. This is the first half of ticket 56 (result page). It was split because the whole of 56 did not fit one agent session: it hit the memory cap twice. Ticket 56 builds the screen on top of this reader. DB tests use PGlite. Do not apply migrations to the live database.

## Definition of done
A function returns, for one submitted attempt of the signed-in student: score, total, percent, right, wrong, skipped, time taken, and the list of wrong questions (short stem, the student's answer, the right answer). The score is the server-stored score, never recomputed in the browser (0031 attempt score guard). Right answers are returned only for a submitted attempt (0030 key lock). An attempt that auto-submitted at the deadline returns the same shape. Another student's attempt, or an attempt not yet submitted, returns nothing.

## Vertical slice
- service: `result.ts` reader plus its types in `types.ts`
- No UI. No i18n. No migration unless a function is strictly needed: if so use **0058** and say why in the header.

## Test that proves it
Fixture attempts: all right, all wrong, some skipped, deadline auto-submit. Counts add up to the question total. The score equals the server-stored score. A student cannot read another student's result (PGlite RLS test). An unsubmitted attempt returns no right answers. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these, use `sed -n` ranges, never `cat` a whole file)
- Types and client: `web/src/lib/attempts/types.ts`, `web/src/lib/attempts/supabase-attempts-client.ts`
- Schema for reference only: `web/supabase/migrations/0013_attempts.sql`, `web/supabase/migrations/0030_exam_key_lock.sql`
- Test setup to copy from: `web/test/db.ts`, `web/test/attempt-score-guard.test.ts`
- Do not open any component, page or `i18n.ts` file. Do not grep the whole repo.
- Work order: 1) write the failing test, 2) the reader, 3) full checks. Commit after each step.

## Notes / scope guard
No screens. No review route (ticket 57), no rank, no share, no topic split.

<!-- ralph 2026-11-09T23:23:33.670Z: committed + tests pass -->
