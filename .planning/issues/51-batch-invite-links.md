---
id: 51-batch-invite-links
status: todo
type: afk
depends_on: [H6-teacher-v11-picks, 50-mock-editor-power-tools]
---
# Batches like a Telegram group: invite links, join requests, members

Decision D3 (from H6): A, confirmed by Boss 2026-11-06. A = teacher picks per link: open join or "ask to join"; default open.

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` sections 4, 5, 7. DB tests use PGlite. This ticket owns migration **0046** only.

Today (`0019_batches.sql`): `batches.join_code` (6 chars), `join_batch(code)` is the only writer of `batch_members`, sync triggers keep `set_access`. Pages: `/teacher/batches`, `/teacher/batches/[batchId]`, `/join/[code]`, `/api/batches/join`.

## What to build
1. `0046_batch_invites.sql` (rollback note): `batch_invites` (random 16+ char URL-safe token, label, `expires_at` null = never, `max_uses` null = no limit, `uses`, `needs_approval`, `revoked_at`), `batch_join_requests` (pending/approved/rejected, unique pending per user+batch), `batches.member_cap` (null = none), `batch_bans`. RPC `join_by_invite(token)` (SECURITY DEFINER, only writer): refuses revoked, expired, used-up, banned, over cap; open link -> member; approval link -> pending request. `decide_join_request(id, approve bool)` owner only. `remove_member(batch, user, ban bool)`. `leave_batch(batch)` for students. Old `join_batch(code)` keeps working (counts as an open link).
2. Teacher batch page: Links tab (create with label, expiry 1 day / 7 days / 30 days / never, use limit, open or ask-to-join; copy, share to WhatsApp and Telegram via `https://wa.me/?text=` and `https://t.me/share/url?url=`, QR code drawn locally without a new dependency if possible, else show the link only; revoke). Requests tab (approve / reject, approve all). Members tab (search, joined date, last active, remove, remove + ban). Settings (name, member cap).
3. Student: `/join/[token]` shows batch name, teacher, member count, and Join or Ask to join; pending state screen; "Leave batch" in Me.
4. Teacher notification when a request arrives (reuse ticket 09 notifications if it fits; otherwise a badge count only).
5. Rate limit `join_by_invite` 10 per minute per user (reuse any existing limiter; otherwise a simple DB counter).

## Test that proves it
PGlite: each refusal case; approval flow grants set access only after approve; ban blocks rejoin through any link; revoke does not remove existing members; cap enforced under two concurrent joins. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No chat (D4). Helper/co-teacher role UI is Upcoming. Do not apply the migration live.

<!-- ralph 2026-11-09T18:51:51.046Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.196Z: upstream 56-result-page blocked -->
