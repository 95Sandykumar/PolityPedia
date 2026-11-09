---
id: 67-teachers-filter-and-free-badge
status: todo
type: afk
depends_on: []
---
# Teachers list uses the student's exam and shows the free sample

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gaps 6, 8, 10 and steps 6, 7. This ticket may own migration **0050**; create it only if a view is truly needed. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today the Teachers list shows every approved teacher A to Z. The exam a student picked at onboarding is never used. Nothing says a teacher has a free test.

## Definition of done
1. The Teachers list shows teachers who teach the student's chosen exams by default, with a "Show all" switch. Teachers with a free sample come first.
2. A card shows a "Free sample" badge when the teacher has a live set with a free sample test. The teacher page Mocks tile shows the same badge.
3. If a view is needed to read the badge cheaply, add `0050_teacher_free_sample.sql` (rollback note at the top). If not needed, create no migration.

## Vertical slice
- service: list reader with exam filter and free-sample flag
- UI: filter switch, badge on cards and tile
- schema: only if needed (0050)

## Test that proves it
Reader tests: filter on and off, sort order, badge only for live sets (draft and archived sets do not count). PGlite test for the view if one is added. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B8: one query for the list, never one per teacher. Never expose draft sets or alias real names.

## Notes / scope guard
No ratings, no search, no student counts.

<!-- ralph 2026-11-09T19:37:09.898Z: no new commit -- slice unfinished -->

<!-- ralph 2026-11-09T21:52:50.410Z: no new commit -- slice unfinished -->
