---
id: 59-start-screen-and-submit-confirm
status: todo
type: afk
depends_on: [58-exam-answer-queue]
---
# Start screen, submit confirm, honest locked wording

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-3 steps 11, 14 and gap 6 and 10; persona-1 step 9; persona-2 step 4. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today opening a test or paper URL creates the attempt (and in exam mode starts the clock) on page load. Submit has no confirm step. A locked test URL says "Exam mode is not set up yet".

## Definition of done
1. Opening an exam test shows a start screen: number of questions, minutes, marking scheme, "you cannot pause", and a Start button. The attempt and the clock begin only when Start is tapped.
2. Practice and past paper play show a short intro ("N questions, no timer, answers show as you go") with a Start button, and create the attempt only on Start.
3. If an open sitting already exists, skip the intro and show "Resume".
4. Submit asks first, showing answered, marked and unanswered counts, with Confirm and Back.
5. A locked or archived test shows "This test is locked" (or the right archived wording), not "Exam mode is not set up yet".

## Vertical slice
- service: start action (POST with the student token) that creates or resumes the attempt
- UI: start screen, resume state, submit confirm, locked wording
- i18n: EN and HI

## Test that proves it
PGlite: rendering the play page creates no attempts row; the Start POST creates exactly one; a second Start resumes the same row. Confirm counts match the stored answers. Locked and archived wording tests. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
A page view must not write data. 0041 rules stay: an archived test refuses new sittings, an archived set does not stop a buyer. The server stays the deadline gate.

## Notes / scope guard
Do not change scoring. Result page is ticket 56.

<!-- ralph 2026-11-09T18:51:51.034Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.179Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:24:23.920Z: upstream 58-exam-answer-queue blocked -->

<!-- ralph 2026-11-10T03:11:08.503Z: upstream 58-exam-answer-queue blocked -->

<!-- ralph 2026-11-10T15:59:02.588Z: no new commit -- slice unfinished -->
