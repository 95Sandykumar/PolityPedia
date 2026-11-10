---
id: 57c-review-links-and-retake
status: todo
type: afk
depends_on: [57b-review-route-and-result-button]
---
# Lists link to Review, Retake is its own button, one new row on Retake

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Ticket 57b added the review routes `/t/[teacherId]/mocks/[testId]/review` and `/t/[teacherId]/papers/[paperId]/review`. Today "Review" on a finished sitting in the mock list still links to the play page, which opens a blank new sitting and adds an attempts row. This ticket changes the list links and proves Retake.

## Definition of done
1. In the mock list (`web/src/components/mock-list.tsx`, the button near lines 346 to 370): a taken test (`isTaken(test)`) shows "Review", which links to the review route of that test. An untaken test still shows "Attempt" and links to the play page.
2. In the past papers list (`web/src/components/papers-list.tsx`, near lines 232 to 280): a paper with `known.done` shows a "Review" link to the paper review route, next to the existing Practice link. "Practice" stays and starts a new sitting.
3. "Retake" is a separate button on the review page (the `retakeHref` link already built in `AttemptReviewPanel`) and is the only way from Review to a new sitting.
4. i18n EN and HI for any new label.

## Test that proves it
- Component tests: a taken test links to the review route, an untaken test links to the play route. A done paper shows the Review link.
- PGlite test: opening the review route adds 0 attempts rows. Following Retake (the play route) adds exactly 1 new attempts row.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
A page view must not write data. B3 prefetch wrapper on links. Do not change the reader or panel.

## Notes / scope guard
No analytics, no sharing. Start screens are ticket 59. No migration. Do not touch the review routes (57b).

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- `web/src/components/mock-list.tsx` lines 340 to 375 (the Attempt/Review button), `mockPlayerPath` helper (find with `grep -n mockPlayerPath web/src/lib/attempts/types.ts`)
- `web/src/components/papers-list.tsx` lines 228 to 282, and `playerPath` in `web/src/lib/attempts/types.ts`
- Existing tests: `web/src/components/__tests__/mock-list.test.tsx`, `papers-list.test.tsx`; DB test style: `web/test/attempt-review.test.ts`
- i18n: `web/src/lib/i18n.ts` (add keys only)
- Do not open migrations. Do not grep the whole repo.
- Work order (commit after each step): 1) mock list link plus test, 2) papers list link plus test, 3) PGlite row count test, 4) i18n, 5) full checks.
