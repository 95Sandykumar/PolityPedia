---
id: 56-result-page
status: done
type: afk
depends_on: [56a-result-reader]
---
# Result page after a practice or exam sitting (screen only)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 4, persona-2 gap 7, persona-3 gap 6. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI through the existing i18n file.

The reader is built by ticket 56a (`web/src/lib/attempts/result.ts`). This ticket is the screen only: do not rewrite the reader. Today Finish ends on one line: "Score 12 / 20". The payoff moment of the whole journey is empty.

## Definition of done
After Finish (practice, past paper and exam mode) the student sees a result page with: score and total, percent, right, wrong, skipped, time taken, the list of wrong questions (short stem, the student's answer, the right answer), a note "N wrong answers were saved to Saved", and a "Next test" link. A partly finished sitting that auto-submitted at the deadline shows the same page.

## Vertical slice
- UI: result page/section replaces the one-line score in the practice and exam players, using the reader from 56a
- i18n: EN and HI

## Test that proves it
Fixture attempts: all right, all wrong, some skipped, deadline auto-submit. Counts add up to the question total. The score shown equals the server-stored score. A student cannot read another student's result (PGlite RLS test). `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0031 attempt score guard: show the stored server score, never the browser's. 0030 key lock: right answers appear only after submit. B3 prefetch wrapper on links.

## Notes / scope guard
No review route (ticket 57), no rank, no share, no topic split.

## Start here (file map, read ONLY these, use `sed -n` ranges, never `cat` a whole file)
- Reader from 56a: `web/src/lib/attempts/result.ts` and its types
- Players that show the one-line score: `web/src/components/exam-player.tsx` (score line near 504, `finalScore` near 141 and 178), `web/src/components/question-player.tsx`, `web/src/components/practice-player.tsx`, `web/src/components/mock-exam-player.tsx`
- Shared pieces: `web/src/components/student-ui.tsx` (prefetch link wrapper), `web/src/lib/i18n.ts` (add keys only, near the `player.` keys)
- Tests: copy the style of the existing component tests next to the players in `web/src/components/__tests__/`
- Do not open migrations or DB test setup. Do not grep the whole repo.
- Work order: 1) result component plus its test, 2) wire into one player, 3) wire into the others, 4) i18n, 5) full checks. Commit after each step.

<!-- ralph 2026-11-10T00:02:14.256Z: committed + tests pass -->
