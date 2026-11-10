---
id: 58-exam-answer-queue
status: blocked
type: afk
depends_on: [56-result-page]
---
# Exam answers survive a bad network

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-3 gap 3 (step 12 and 13). DB tests use PGlite. Outside services faked. Do not apply migrations to the live database.

Today the exam player fires each answer save and swallows any error. A comment in the browser exam client talks about a retry queue that does not exist. If the phone goes offline, answers look saved but are not, and the score drops with no warning. If the network is down at 00:00, auto-submit fails once and does not retry.

## Definition of done
In exam mode, an answer that cannot be saved is kept in a local queue (localStorage, every access wrapped in try/catch, page works without it) and resent in order when the network returns. An offline bar says answers are kept on this phone. Unsaved answers show a "saving" mark. Before Submit and before auto-submit, the queue is flushed first. If the flush fails, Submit shows "Could not save N answers. Try again." and auto-submit retries every 10 seconds until the server deadline. Reloading the page restores the queue. The server stays the gate: answers after the deadline are still refused.

## Vertical slice
- service: queue module (enqueue, flush in order, dedupe by question, restore)
- UI: offline bar, saving mark, submit error text
- fix the stale comment about the retry queue

## Test that proves it
Fake fetch that fails then succeeds: the queue flushes in order with no duplicates. Submit waits for the flush. Reload restores the queue. Auto-submit retry fires on the 10 second schedule (fake timers). `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B6: bounded retry, at most one request per 10 seconds while failing, stop on unmount. The save endpoint is already an upsert, so a resend is safe. Store only attempt id, question id and chosen option locally.

## Notes / scope guard
No service worker (ticket 78). Practice mode already has an offline queue: reuse its approach where it fits.

<!-- ralph 2026-11-09T18:51:51.031Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.177Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:24:23.910Z: no new commit -- slice unfinished -->
