---
id: 73-practise-saved-session
status: blocked
type: afk
depends_on: [72-saved-cards-show-answers]
---
# Practise your saved questions as one session

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-2 gap 4 and opportunity 3. This ticket owns migration **0052**; create it only if the attempts table cannot hold a saved-source sitting. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

## Definition of done
A "Practise these" button on Saved (for the Wrong or Marked filter) starts one practice session with those questions in the existing question player, with answer and explanation after each. Finish shows the result page (ticket 56). The session never changes the student's earlier attempts. Questions the student cannot access are skipped.

## Vertical slice
- schema: 0052 only if needed (rollback note at the top)
- service: create the session, serve the questions, score on the server
- UI: button, player reuse, result

## Test that proves it
PGlite: a session is created, answers saved, the score is computed on the server; only the student's own saved questions are used; a question from a set the student lacks access to is excluded. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0031: score written on the server only. 0030: keys only after submit. A page view must not write: the session starts on a Start tap.

## Notes / scope guard
No due dates or intervals (ticket 74).

<!-- ralph 2026-11-09T18:51:51.062Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.217Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:17:23.776Z: upstream 57-review-and-retake blocked -->

<!-- ralph 2026-11-10T03:45:31.388Z: upstream 72-saved-cards-show-answers blocked -->
