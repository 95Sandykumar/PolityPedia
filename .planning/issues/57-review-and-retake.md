---
id: 57-review-and-retake
status: done
type: afk
depends_on: [57a-review-reader, 57b-review-route-and-result-button, 57c-review-links-and-retake]
---
# Review opens the finished sitting; Retake is its own button (screens only)

> CLOSE-OUT ONLY. The first run built the review component but wired nothing. The wiring is now tickets 57b (routes, result button) and 57c (list links, Retake test). This ticket only checks that the Definition of done below is true in the running code. Do not rebuild. If it is all true, add a one line note and commit.

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 5, persona-3 step 16. DB tests use PGlite. Do not apply migrations to the live database.

The read only reader is built by ticket 57a: reuse it, do not rewrite it. This ticket is the screens. Today "Review" on a finished practice test opens a blank new sitting, and in exam mode it can start a new timed sitting. Each tap also adds an attempts row.

## Definition of done
On the mock list, past papers list and the result page: "Review" on a submitted sitting opens that sitting read only: every question with the student's answer, the right answer and the explanation. Opening Review never creates an attempt row. "Retake" is a separate button that starts a new sitting. The result page (ticket 56) gets a "Review mistakes" button.

## Vertical slice
- UI: read-only review view, Retake button, link changes in the mock list and papers list, "Review mistakes" button on the result page
- i18n: EN and HI

## Test that proves it
Component test for the read-only view. A test that the Review link points to the review view and Retake starts a new sitting (exactly one new attempts row, PGlite). `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0030 key lock: keys and explanations show only for a submitted attempt. A page view must not write data. B3 prefetch wrapper.

## Notes / scope guard
No analytics, no sharing. Start screens are ticket 59.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- Reader from 57a (read the new function signature only), result component from 56 (find with `git log --stat -3 -- web/src/components`)
- Where the Review and Retake links live: `web/src/components/mock-list.tsx`, `web/src/components/papers-list.tsx`
- Existing play route to copy the shape of for a review route: `web/src/app/(student)/t/[teacherId]/mocks/[testId]/play/page.tsx`
- Shared pieces: `web/src/components/student-ui.tsx` (prefetch link wrapper), `web/src/lib/i18n.ts` (add keys only)
- Do not open migrations. Do not grep the whole repo.
- Work order: 1) review view plus test, 2) Retake button plus test, 3) link changes in the two lists, 4) result page button, 5) i18n, 6) full checks. Commit after each step.

<!-- ralph 2026-11-10T15:59:28.556Z: shipped on ralph/night-2026-11-10-696 as bc02061 feat(review): the read-only review screen of a finished sitting (57-review-and-retake) -->
