---
id: 56c-result-read-after-submit
status: blocked
type: afk
depends_on: [56b-result-page-practice-and-fixes]
---
# Result read must wait for the submit (practice and past paper)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. A reviewer found a race in ticket 56b. In `web/src/components/question-player.tsx`, `finish()` (near line 298) calls `setFinished(true)` and starts `onFinish` (the submit POST, `web/src/components/practice-player.tsx` near line 98) without waiting for it. The result effect (near lines 222 to 235) starts `readResult(attemptId)` as soon as `finished` is true, at the same time as the submit. The reader returns null for a sitting with no `submitted_at` (`web/src/lib/attempts/result.ts` near 142). If the read lands first, it gets null, the latch is set, nothing retries, and the old one-line score stays. So the panel shows on some Finishes and not others. Exam mode is fine: `exam-player.tsx` (near 194 to 202) awaits `client.submit` before it sets `submitted`.

## Definition of done
In `QuestionPlayer`, the result is read only after the `onFinish` promise has settled. If the submit fails, the old one-line score stays (as today) and no result read runs. No other behaviour changes. Do not touch the reader, the panel or the exam player.

## Test that proves it
A component test with a fake `onFinish` that resolves late and a fake `readResult` that returns null until the submit has resolved. Before the fix, the panel does not show. After it, the panel shows. A second test: `onFinish` rejects, the old score shows, `readResult` is never called. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
No migration. No new i18n. 2 files at most plus the test.

## Start here (file map, read ONLY these, use `sed -n` ranges, never `cat` a whole file)
- `web/src/components/question-player.tsx` lines 160 to 170 (state), 215 to 240 (result effect), 295 to 310 (`finish`)
- `web/src/components/practice-player.tsx` lines 80 to 105 (`onFinish`)
- `web/src/components/exam-player.tsx` lines 190 to 205 (the correct pattern to copy)
- Test: `web/src/components/__tests__/question-player.test.tsx`
- Work order (commit after each step): 1) failing test, 2) the fix, 3) full checks.

<!-- ralph 2026-11-10T14:47:18.164Z: tests FAILED in worktree -->
