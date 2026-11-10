---
id: 58b-exam-queue-fixes
status: todo
type: afk
depends_on: [58-exam-answer-queue]
---
# Exam answer queue: two bugs a reviewer found

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Ticket 58 added an answer queue (`web/src/lib/exam/exam-answer-queue.ts`) and wired it into `web/src/components/exam-player.tsx`. A reviewer found two real bugs. Fix only these two. Do not redesign the queue.

## Definition of done
1. **Deadline must not be gated by the queue.** Today `submit()` in `exam-player.tsx` (near lines 258 to 275) returns false when `queue.flush()` still holds an answer. The server refuses answers after the deadline (`web/supabase/migrations/0018_exam_mode.sql`, line 94 area) but `score_attempt` still works after the deadline so an auto-submit still works (line 290 area). So a held answer that the server refuses blocks Submit and auto-submit for good, and the sitting is never scored. Fix: when the time is up (`left === 0`, the auto-submit path), do not gate on held answers: try one flush, then submit anyway. For the manual Submit button before the deadline, keep the gate. Also make the queue drop an answer the server refuses permanently (a 4xx), so it cannot sit there forever. A network failure or a 5xx stays held.
2. **`queue.stop()` must be reversible.** Today `stop()` sets `stopped = true` for good and runs in the mount effect cleanup (near line 385). `next.config.ts` has `reactStrictMode: true`, so in dev React runs mount, cleanup, mount on the same queue and after that no answer is ever sent. Fix: build the queue inside the effect, or add a `start()` that clears `stopped` and call it on mount. Production behaviour must not change.
3. The 10 second retry timer (near line 400) must stop when nothing is held and must not run forever once the sitting is submitted.

## Test that proves it
- Unit test on the queue: a 4xx reply drops the answer and `flush()` returns 0. A 5xx or a thrown fetch keeps it.
- Component test: time reaches 0 while one answer is held and the server refuses it. The sitting is still submitted and the score shows.
- Component test: render `ExamPlayer` inside `<React.StrictMode>`, tap an answer, and see the answer sent.
- Existing 58 tests still pass. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
0031 score guard: the score still comes from `client.submit`, never from the browser. A manual Submit before the deadline must still refuse to score over a held answer.

## Notes / scope guard
No migration. No new i18n unless a message is truly needed. 3 files at most plus tests.

## Start here (file map, read ONLY these, use `sed -n` ranges, never `cat` a whole file)
- `web/src/lib/exam/exam-answer-queue.ts` lines 200 to 295 (`sendAll`, `flush`, `stop`)
- `web/src/components/exam-player.tsx` lines 215 to 225 (queue is built), 255 to 285 (`submit`), 375 to 410 (mount effect and retry timer)
- `web/src/lib/exam/browser-exam-client.ts` (how a failed save is reported: find the status code)
- Tests: `web/src/lib/exam/__tests__/exam-answer-queue.test.ts`, `web/src/components/__tests__/exam-player-queue.test.tsx`
- Do not open other migrations. Do not grep the whole repo.
- Work order (commit after each step): 1) 4xx drop plus test, 2) deadline path plus test, 3) StrictMode plus test, 4) timer check, 5) full checks.
