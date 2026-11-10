---
id: 71-exam-countdown-own-exam
status: blocked
type: afk
depends_on: [69-continue-card]
---
# Exam countdown uses the student's own exam

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 step 1 and gap 10. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today the Home exam card takes the nearest future date among followed teachers and ignores which exam the student chose. A UGC NET student can see a CUET date.

## Definition of done
The Home card shows the nearest future date among followed teachers' dates for the student's chosen exams only, as "N days left". If no matching date exists the card is hidden.

## Vertical slice
- service: date reader filtered by the student's exams
- UI: card text and hide rule

## Test that proves it
Reader tests with two exams, several teachers, past and future dates, and a student with one exam, two exams, and none. Component test. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
Read only, own token. The date is the teacher's date, not an official date: label it with the teacher name as today.

## Notes / scope guard
No daily question target.

<!-- ralph 2026-11-09T18:51:51.022Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.161Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T23:38:30.980Z: upstream 67-teachers-filter-and-free-badge blocked -->

<!-- ralph 2026-11-10T02:33:51.594Z: upstream 54c-read-errors-saved-practice-media blocked -->
