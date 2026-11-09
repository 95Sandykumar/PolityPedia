---
id: 66-papers-question-count
status: done
type: afk
model: haiku
depends_on: []
---
# Papers list shows question count and hides empty Practice

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 step 3, 4 and gap 9. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today a paper row offers Practice even when the paper has no questions, and the student lands on "No questions yet".

## Definition of done
The student papers list shows the question count per paper and a "Done" tick when the student has a submitted attempt on it. When the count is 0, the Practice link is hidden and the row says "Questions coming soon".

## Vertical slice
- service: one count query for the whole list (not one per row)
- UI: count, tick, hidden Practice link

## Test that proves it
Reader test with papers having 0, 1 and many questions and one submitted attempt. Component test for the hidden link. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B8: a single query for the list. Counts only live, non-archived questions the student can read.

## Notes / scope guard
No other papers list changes.

<!-- ralph 2026-11-09T19:25:38.305Z: committed + tests pass -->
