---
id: 75-today-card
status: blocked
type: afk
depends_on: [74-spaced-repetition, 71-exam-countdown-own-exam]
---
# Home "Today" card from due questions

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 opportunity 2 and gap 6. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

## Definition of done
Home shows a "Today" card: "N questions due" (at most 10) with a Start button that opens a practise session (ticket 73) from the due list. When nothing is due: "You are all caught up" with a link to the teacher's mock tests. Order on Home: Continue, Today, exam countdown, teachers, notices.

## Vertical slice
- service: due list for today (own rows)
- UI: Today card and Home order

## Test that proves it
Reader tests: none due, 3 due, 25 due (capped at 10). Component test for both states. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
Read only until Start. A page view must not write.

## Notes / scope guard
No daily goal setting, no streak flame (progress lives in Me, ticket 70).

<!-- ralph 2026-11-09T18:51:51.025Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.164Z: upstream 56-result-page blocked -->
