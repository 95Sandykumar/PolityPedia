---
id: 56b-result-page-practice-and-fixes
status: done
type: afk
depends_on: [56-result-page]
---
# Result page for practice and past papers, plus 3 small fixes

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Ticket 56 put the new result page (`AttemptResultPanel`) into exam mode only. A reviewer found the gaps below on branch `ralph/night-2026-11-09-106760`. This ticket closes them. No migration. No SQL. Do not rewrite the reader (`web/src/lib/attempts/result.ts`) or the panel (`web/src/components/attempt-result.tsx`).

## Definition of done
1. Practice mode and past paper mode (`PracticePlayer` and `QuestionPlayer`) show `AttemptResultPanel` after Finish. Today they still show the old one-line browser score.
2. The "Next test" link shows. The play pages pass `nextHref`:
   - past paper play page: link to the papers list of that teacher, `/t/${teacherId}/papers`
   - mock play page (exam and practice): link to the mocks list of that teacher, `/t/${teacherId}/mocks`
3. StrictMode bug in `exam-player.tsx` (the `askedResult` latch, near lines 254 to 266): the effect cleanup must also set `askedResult.current = false`, so a dev-mode remount still reads the result.
4. Singular text: one wrong answer must read "1 wrong answer was saved to Saved." Add a `result.savedOne` key in EN and HI. Use it when `result.wrong === 1`.
5. Delete the unused `result.percent` i18n key (EN and HI) if nothing reads it. Check with one targeted grep on that key only.

## Test that proves it
- Practice player and question player: after Finish, the result panel shows (right, wrong, skipped counts add up to the total). The old one-line score is gone.
- A test that renders a play page or player with `nextHref` and checks the "Next test" link `href`.
- A test for the singular text (1 wrong) and the plural text (2 wrong).
- A StrictMode test: render ExamPlayer inside `<React.StrictMode>`, submit, and see the result panel.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0031 attempt score guard: show the stored server score, never the browser's. 0030 key lock: right answers only after submit. B3 prefetch wrapper on links.

## Notes / scope guard
No review route (ticket 57), no rank, no share, no topic split.

## Start here (file map, read ONLY these, use `sed -n` ranges, never `cat` a whole file)
- How exam mode wires it (copy this pattern): `web/src/components/exam-player.tsx` (props near 112 to 148, effect near 254 to 266, panel near 394), `web/src/components/mock-exam-player.tsx` (reader built near line 69, passed near 82)
- Panel props: `web/src/components/attempt-result.tsx` (props near 133 to 150)
- To change: `web/src/components/practice-player.tsx` (`onFinish` near 85), `web/src/components/question-player.tsx` (`onFinish` near 91, finish handler near 257, old score line near 472)
- Play pages: `web/src/app/(student)/t/[teacherId]/papers/[paperId]/play/page.tsx` (PracticePlayer near 58), `web/src/app/(student)/t/[teacherId]/mocks/[testId]/play/page.tsx` (MockExamPlayer near 94, PracticePlayer near 108)
- i18n: `web/src/lib/i18n.ts` (`result.saved` near 286 EN and 1005 HI)
- Tests: `web/src/components/__tests__/question-player.test.tsx`, `exam-player.test.tsx`, `mock-practice-player.test.tsx`
- Do not open migrations or DB test setup. Do not grep the whole repo.
- Work order (commit after each step): 1) StrictMode latch plus its test, 2) singular key and `result.percent` cleanup, 3) wire the panel into `QuestionPlayer`/`PracticePlayer` plus tests, 4) pass `nextHref` from both play pages plus test, 5) full checks.

<!-- ralph 2026-11-10T02:57:20.506Z: committed + tests pass -->
