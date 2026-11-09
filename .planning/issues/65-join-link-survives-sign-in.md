---
id: 65-join-link-survives-sign-in
status: blocked
type: afk
depends_on: [64-signin-errors-and-resend]
---
# A join link survives sign-in and names the teacher

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-3 gap 9 and steps 9, 10. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today a signed-out student who opens a teacher's `/join/<code>` WhatsApp link is sent to sign-in and lands on `/` afterwards, so the link is lost. The join page never names the teacher or the batch. After joining, the button goes to the generic teacher list.

## Definition of done
1. A signed-out student opening `/join/<code>` signs in (code or Google) and returns to `/join/<code>`.
2. The return path is same-origin and allow-listed (only `/join/...` and `/t/...`).
3. The join page shows the teacher name, the batch name, and the free sets, plus "Your teacher will see your scores."
4. After joining, the button opens that teacher's mock tests.

## Vertical slice
- UI: join page content, sign-in return path through both sign-in methods
- service: read of batch and teacher names by code (archived batch answers like an unknown code)

## Test that proves it
Redirect tests, including hostile values: `//evil.com`, `https://evil.com`, `javascript:alert(1)`, a path with backslashes. All fall back to `/`. Component tests for the join page. PGlite: an archived batch code reads as unknown. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
C: no open redirect. The `join_batch` RPC stays the only writer. Do not reveal member lists or other students.

## Notes / scope guard
No invite links with expiry (teacher ticket 51). No approval flow.

<!-- ralph 2026-11-09T19:59:47.687Z: no new commit -- slice unfinished -->
