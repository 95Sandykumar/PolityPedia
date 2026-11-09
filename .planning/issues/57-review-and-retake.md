---
id: 57-review-and-retake
status: blocked
type: afk
depends_on: [56-result-page]
---
# Review opens the finished sitting; Retake is its own button

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 5, persona-3 step 16. DB tests use PGlite. Do not apply migrations to the live database.

Today "Review" on a finished practice test opens a blank new sitting, and in exam mode it can start a new timed sitting. Each tap also adds an attempts row.

## Definition of done
On the mock list, past papers list and the result page: "Review" on a submitted sitting opens that sitting read only: every question with the student's answer, the right answer and the explanation. Opening Review never creates an attempt row. "Retake" is a separate button that starts a new sitting. The result page (ticket 56) gets a "Review mistakes" button.

## Vertical slice
- service: read the newest submitted sitting for a test or paper
- UI: read-only review view + Retake button + link changes in the mock list and papers list

## Test that proves it
PGlite: the attempts row count is unchanged after opening Review in practice and exam mode; Retake adds exactly one row. Component test for the read-only view. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0030 key lock: keys and explanations show only for a submitted attempt. A page view must not write data. B3 prefetch wrapper.

## Notes / scope guard
No analytics, no sharing. Start screens are ticket 59.

<!-- ralph 2026-11-09T18:51:51.057Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.212Z: upstream 56-result-page blocked -->
