---
id: 77-weak-topic-chips
status: blocked
type: afk
depends_on: [70-progress-and-streak, 76-topic-filter]
---
# Weak-topic chips in progress

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 opportunity 7. DB tests use PGlite. Do not apply migrations to the live database; extend the 0051 progress view only through a NEW migration if the view must change (use 0051 only if it is not yet applied anywhere; otherwise reuse the existing view and compute in the service). Strings in EN and HI.

## Definition of done
Me progress shows up to 3 weak topics: the lowest accuracy topics with at least 5 answered questions. Each chip reads like "Federalism 40%" and starts a 10 question topic practice. Fewer than 5 answered in every topic: the section is hidden.

## Vertical slice
- service: accuracy per topic for the caller (own rows)
- UI: chips and start action

## Test that proves it
PGlite fixture: threshold of 5, sort order, ties, ownership (student A never sees B). Component test. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B8: one query. Read only until the student taps a chip.

## Notes / scope guard
No teacher-side topic reports (teacher ticket 53 owns those).

<!-- ralph 2026-11-09T18:51:51.029Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.173Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T23:38:30.978Z: upstream 67-teachers-filter-and-free-badge blocked -->
