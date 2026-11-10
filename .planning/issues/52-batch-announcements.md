---
id: 52-batch-announcements
status: blocked
type: afk
depends_on: [51-batch-invite-links]
---
# Batch announcements: teacher posts to one batch, members read

Decision D4 (from H6): A, confirmed by Boss 2026-11-06. A = teacher-only posting (like a Telegram channel). Student chat is Upcoming.

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` section 4. DB tests use PGlite. This ticket owns migration **0047** only. Reuse the safe link rendering and (if present) the link preview helper from ticket 48.

## What to build
1. `0047_batch_announcements.sql` (rollback note): `batch_posts(id, batch_id, author_id, body <=2000, link, pinned_at, created_at, edited_at)`. Owner writes/edits/deletes; members read; archived batch = read only. Max 1 pinned per batch.
2. Teacher batch page: Announcements tab with composer, pin, edit, delete. Option "Attach a mock test" (pick a test from the batch's sets, renders as a Start button).
3. Student: "My batches" list with unread dot (store `last_read_at` per member; add the column in 0047), batch page with pinned post on top then newest first.
4. Notification to members on a new post (reuse ticket 09 path; one notification row per member, inserted in one statement).

## Test that proves it
PGlite: non-member cannot read, member cannot write, second pin refused, archived batch refuses new post. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No replies, reactions or student posts. No push notifications. Do not apply the migration live.

<!-- ralph 2026-11-09T18:51:51.048Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.198Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.347Z: upstream 54-visible-read-errors blocked -->

<!-- ralph 2026-11-10T02:33:51.601Z: upstream 54c-read-errors-saved-practice-media blocked -->
