---
id: 56-result-page
status: blocked
type: afk
depends_on: []
---
# Result page after a practice or exam sitting

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 4, persona-2 gap 7, persona-3 gap 6. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI through the existing i18n file.

Today Finish ends on one line: "Score 12 / 20". The payoff moment of the whole journey is empty.

## Definition of done
After Finish (practice, past paper and exam mode) the student sees a result page with: score and total, percent, right, wrong, skipped, time taken, the list of wrong questions (short stem, the student's answer, the right answer), a note "N wrong answers were saved to Saved", and a "Next test" link. A partly finished sitting that auto-submitted at the deadline shows the same page.

## Vertical slice
- service: result reader that returns counts and the wrong list for a submitted attempt (own rows only)
- UI: result page/section replaces the one-line score in the practice and exam players
- i18n: EN and HI

## Test that proves it
Fixture attempts: all right, all wrong, some skipped, deadline auto-submit. Counts add up to the question total. The score shown equals the server-stored score. A student cannot read another student's result (PGlite RLS test). `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0031 attempt score guard: show the stored server score, never the browser's. 0030 key lock: right answers appear only after submit. B3 prefetch wrapper on links.

## Notes / scope guard
No review route (ticket 57), no rank, no share, no topic split.

## Start here (file map, read ONLY these)
Do not grep the whole repo. Do not `cat` whole files: use `sed -n` ranges or `grep -n`.
- Player that shows the one-line score today: `web/src/components/exam-player.tsx` (the score line is near line 504, `finalScore` state near lines 141 and 178). Also `web/src/components/mock-exam-player.tsx`.
- Page that mounts the player: `web/src/app/(student)/t/[teacherId]/mocks/[testId]/play/page.tsx`
- Attempt data and types: `web/src/lib/attempts/types.ts`, `web/src/lib/attempts/student-page.ts`, `web/src/lib/attempts/supabase-attempts-client.ts`
- Strings: `web/src/lib/i18n.ts`
- Work order: 1) result reader plus its PGlite test, 2) result component, 3) wire into both players, 4) i18n, 5) full checks. Commit after each step.

<!-- ralph 2026-11-09T21:25:09.150Z: no new commit -- slice unfinished -->
