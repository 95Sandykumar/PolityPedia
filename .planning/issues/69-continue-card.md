---
id: 69-continue-card
status: todo
type: afk
depends_on: [56-result-page, 68-free-test-card-and-mock-list-cleanup]
---
# Home "Continue" card for an open test

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 step 1, gap 6 and the "next morning" table. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today the server resumes an open sitting, but Home and Practice never tell the student that one exists. The demo student had at least two open sittings nothing surfaced.

## Definition of done
Home shows "Continue" as its first card when the student has an open (not submitted, not expired) attempt: test or paper name, mode, question number, one tap to resume. An exam sitting past its deadline shows "Submit your finished paper" instead. No open attempt: no card.

## Vertical slice
- service: newest open attempt for the signed-in student
- UI: Continue card on Home
- i18n: EN and HI

## Test that proves it
Reader tests: none open, one open practice, one open exam, expired exam, several open (newest wins). Component test. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
Read only, own token, RLS decides rows. B3 prefetch wrapper.

## Notes / scope guard
No streak or progress here (ticket 70).

<!-- ralph 2026-11-09T18:51:51.018Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.157Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T23:38:30.979Z: upstream 67-teachers-filter-and-free-badge blocked -->
