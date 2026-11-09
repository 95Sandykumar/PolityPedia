---
id: 70-progress-and-streak
status: todo
type: afk
depends_on: [69-continue-card]
---
# Progress and streak in Me

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 step 12 and gaps 2, 3. This ticket owns migration **0051** only. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today Me shows email, language and plan only. Attempts and scores are never summed up.

## Definition of done
Me shows "Your progress": tests taken, overall accuracy, current streak (days in a row with at least one answered question, India time), and a 14 day activity strip. The numbers come from a view or function in `0051_student_progress.sql` (rollback note at the top) that reads only the caller's own rows. A new student sees a friendly empty state.

## Vertical slice
- schema: 0051 view or function
- service: progress reader
- UI: progress section in Me
- i18n: EN and HI

## Test that proves it
PGlite: attempts across several days give the right streak and accuracy; a gap day resets the streak; student A cannot read student B's numbers; empty state for a new student. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B8: one query for the section. Check existing indexes on attempts and attempt answers before adding any. Time zone is Asia/Kolkata.

## Notes / scope guard
No leaderboard, no goals, no topic split (ticket 77).

<!-- ralph 2026-11-09T18:51:51.027Z: upstream 56-result-page blocked -->
