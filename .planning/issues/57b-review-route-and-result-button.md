---
id: 57b-review-route-and-result-button
status: done
type: afk
depends_on: [57a-review-reader, 56b-result-page-practice-and-fixes]
---
# Review route for a finished sitting, and the result page button

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Ticket 57a built the read only reader (`web/src/lib/attempts/review.ts`) and ticket 57 built the component `AttemptReviewPanel` (`web/src/components/attempt-review.tsx`). A reviewer found that nothing uses them: no route exists, the lists still link to the play page, and the result page has no "Review mistakes" button. This ticket adds the two routes and the result page button. The list links and the Retake test are ticket 57c. Do not rewrite the reader or the panel.

## Definition of done
1. Two new pages, server components, one for a test and one for a past paper: `web/src/app/(student)/t/[teacherId]/mocks/[testId]/review/page.tsx` and `web/src/app/(student)/t/[teacherId]/papers/[paperId]/review/page.tsx`. Each calls `readAttemptReview` with the student's own token, renders `AttemptReviewPanel`, and passes `retakeHref` (the play path of the same test or paper). If the reader returns null (no submitted sitting, or not this student's), show the existing empty or not found state. Never show a different message for the two cases.
2. A page view writes nothing: no attempts row is created.
3. The result page (`web/src/components/attempt-result.tsx`) gets a "Review mistakes" link to the matching review route. It uses the prefetch wrapper from `student-ui.tsx` with prefetch off. The play pages pass the review href in as a prop, like `nextHref`.
4. i18n EN and HI for "Review mistakes".

## Test that proves it
- Page test or component test: the review route renders `AttemptReviewPanel` with the data of a submitted sitting, and renders the empty state for null.
- A test that the result panel shows the "Review mistakes" link with the right `href` when the prop is set, and not when it is not.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0030 key lock: keys and explanations only for a submitted sitting (the reader already enforces it; do not bypass it). A page view must not write data. B3 prefetch wrapper on links.

## Notes / scope guard
No list link changes (57c). No Retake test (57c). No migration. No new reader code.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- Reader: `web/src/lib/attempts/review.ts` (`readAttemptReview` near line 110, `createSupabaseReviewSource` near line 237)
- Component: `web/src/components/attempt-review.tsx` (`AttemptReviewPanel` props near lines 218 to 240)
- Page shape to copy: `web/src/app/(student)/t/[teacherId]/mocks/[testId]/play/page.tsx` (auth, mode, `BackLink`, `PageHeader`) and `web/src/app/(student)/t/[teacherId]/papers/[paperId]/play/page.tsx`
- Result button: `web/src/components/attempt-result.tsx` (props near 133 to 150, `nextHref` link near 259), and where the play pages pass `nextHref` (near line 106 of the mocks play page)
- i18n: `web/src/lib/i18n.ts` (add keys only, near the `result.` keys)
- Do not open migrations or DB test setup. Do not grep the whole repo.
- Work order (commit after each step): 1) mocks review page plus test, 2) papers review page plus test, 3) result page button plus test, 4) i18n, 5) full checks.

<!-- ralph 2026-11-10T15:09:05.582Z: committed + tests pass -->
