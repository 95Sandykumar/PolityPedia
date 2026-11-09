---
id: 72-saved-cards-show-answers
status: blocked
type: afk
depends_on: [57-review-and-retake]
---
# Saved cards show the answer; Remove becomes quiet

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 step 9 and gap 4. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today a Saved card shows only the stem, and a loud red Remove button. The paper "Open" link opens the whole paper. A mock question has no Open link.

## Definition of done
1. Each Saved card expands to show the right answer and the teacher explanation.
2. Remove is a small quiet control with a 5 second undo that restores the row.
3. "Open" never leads to the wrong place: it opens the question inside its test review or paper at that question where possible, otherwise the link is removed.

## Vertical slice
- service: saved reader returns key and explanation only for questions the student may read
- UI: expandable card, quiet Remove with undo, fixed Open link

## Test that proves it
Component tests: expand, remove, undo. Reader test: a question from a set the student has no access to is not revealed. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
Follow the existing question access rules and key lock (0030). Do not add any bypass.

## Notes / scope guard
No practise session (ticket 73). No spaced repetition.

<!-- ralph 2026-11-09T18:51:51.060Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.214Z: upstream 56-result-page blocked -->
