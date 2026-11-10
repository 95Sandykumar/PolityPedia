---
id: 74-spaced-repetition
status: todo
type: afk
depends_on: [73-practise-saved-session]
---
# Spaced repetition for wrong answers

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 gap 2 and opportunity 4. This ticket owns migration **0053** only. The old comment "NO SPACED REPETITION" in migration 0014 is history: do not edit old migrations. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

## Definition of done
Saved wrong questions get a due date. After a wrong answer the question is due in 1 day. Each correct answer in a practise session moves the interval to 3 days, then 7 days. A wrong answer resets it to 1 day. The Saved tab shows an "N due" badge and the Saved list shows due questions first. The scheduling rule is one pure function.

## Vertical slice
- schema: `0053_saved_due.sql` adds due date, interval days and repetitions to saved questions (rollback note at the top)
- service: scheduler (pure function), due reader, update after a session answer
- UI: badge and sort

## Test that proves it
Table tests for the scheduler (10+ cases: first wrong, correct chain, wrong reset, long gap). PGlite: due query returns only own rows; badge count correct. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B8: one query for the badge. India time for "due today".

## Notes / scope guard
No push, no email. The Home Today card is ticket 75.

<!-- ralph 2026-11-09T18:51:51.064Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.220Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:17:23.779Z: upstream 57-review-and-retake blocked -->
