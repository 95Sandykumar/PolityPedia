---
id: 57d-review-page-read-error-and-topic
status: todo
type: afk
depends_on: [57b-review-route-and-result-button]
---
# Review pages: a failed read is not "nothing to review", and Retake keeps the topic

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Ticket 57b added two review pages. A reviewer found two defects. Ticket 54 made read errors visible on other screens. Copy how 54 does it (`web/src/lib/` read result type from ticket 54a, and the guard test `web/src/lib/__tests__/no-swallowed-student-reads.test.ts`).

## Definition of done
1. In `web/src/app/(student)/t/[teacherId]/mocks/[testId]/review/page.tsx` (near line 51) and `.../papers/[paperId]/review/page.tsx` (near line 45) the reader call ends in `.catch(() => null)`. The reader `readAttemptReview` (`web/src/lib/attempts/review.ts`, near line 288) also returns null on any non-ok reply, for example an expired token (401). A student with a finished sitting then sees "nothing to review". Fix: a failed read shows the read error state used on the other 54 screens, with a retry. A real "no submitted sitting" or "not yours" still shows one identical empty state. Do not change what the null case looks like.
2. Retake from the mock review page (near line 66) builds `?mode=` only, so retaking a topic filtered sitting starts the full paper. Keep the topic of the sitting that was reviewed, if the reader returns it. If the reader does not return it, add the field to the reader result (read only, no migration).
3. Extend the 54 guard test so it also scans `web/src/lib/attempts/review.ts` and the two review pages.

## Test that proves it
- Page test: reader fails (throws, and returns a 401 style error) shows the read error state, not the empty line. Reader returns null shows the empty line.
- A test that Retake href carries the topic of the reviewed sitting.
- The guard test fails if a new `.catch(() => null)` is added to a review page.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
A page view writes nothing. 0030 key lock stays in the reader. B3 prefetch wrapper on links.

## Notes / scope guard
No migration. Do not touch 58 or the exam player. 4 files at most plus tests.

## Start here (file map, read ONLY these, use `sed -n` ranges, never `cat` a whole file)
- `web/src/lib/attempts/review.ts` lines 100 to 130, 230 to 300
- The two review pages (whole files, they are about 70 lines)
- A 54 example to copy: `web/src/app/(student)/t/[teacherId]/news/page.tsx`
- Guard: `web/src/lib/__tests__/no-swallowed-student-reads.test.ts`
- Tests: `web/src/app/__tests__/` (find the review pages test with `ls`)
- Work order (commit after each step): 1) failed read state plus test, 2) topic on Retake plus test, 3) guard test, 4) full checks.
