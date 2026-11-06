---
id: 37-ai-claim-secret
status: done
type: afk
depends_on: [36-exam-leaks-close]
---
# Fix: the AI cost hole is still open, a claimant can refund themselves mid-call

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Claude and Supabase network calls are faked in tests. SQL migrations live in `web/supabase/migrations/`. Name yours `0038_ai_claim_secret.sql` (0036 and 0037 are taken). DB tests use PGlite through `web/test/db.ts` with `db.asUser`.

This is a SECURITY FIX. Ticket 32 (`0032_ai_claim_tokens.sql`) stopped OTHER users from finishing or failing a claim, but a reviewer proved with a PGlite probe that the CLAIMANT can still cheat.

## What is wrong (re-confirm with a failing test FIRST)
- The server routes (`src/app/api/revision/route.ts`, `src/lib/ai/supabase-ai-client.ts`, `src/lib/ai/supabase-audio-client.ts`) call Supabase with the USER's own token (there is no service key). So `claimed_by = auth.uid()` also lets the user call `rpc/fail_ai_explanation` from their browser WHILE the server's model call runs. Probe: claim, fail (count goes back), claim again, three cycles. Every cycle costs a Claude call and the daily count stays 0. The same holds for `fail_explanation_audio`.
- Takeover refund race (`claim_ai_explanation`, 0032): it reads the stale row without a row lock. If the first claimant's `fail` lands between that read and the upsert, the first claimant is refunded twice. Fix with `select ... for update` on the row.

## Definition of done
1. The claim returns a one-time secret (random uuid) ONLY to the call that created or took over the claim. Store only its hash, or keep it in a column the client roles cannot select (revoke column select from `anon` and `authenticated`, or a side table with no policies). `finish_*` and `fail_*` (explanation and audio) require the matching secret as an extra argument, besides `claimed_by`. A user who calls claim themselves over REST gets a secret, but then no model call is made for that claim (the route sees `generating` and waits or answers busy), so no Claude cost is spent.
2. The route holds the secret in server memory only and never returns it to the browser or logs it.
3. A refund only happens when `fail` is called with the right secret (model failed before any text). A browser cannot guess or read it.
4. Takeover locks the row, refunds the previous claimant at most once, and the old secret stops working after a takeover.
5. Update `src/lib/ai/*` callers, fakes and types. Keep the revision screen, teacher edit and audio flow working. Replace the old signatures and update every caller.

## Test that proves it
PGlite: the claimant calls `fail_ai_explanation` with no secret or a wrong secret: refused. With the right secret: refunds once, and a second call refunds nothing. `finish` with a wrong secret: refused. Claim, then a second claim by the same user returns busy and no secret. Stale takeover by user B refunds A exactly once even when A's fail runs after (the old secret is dead). The same set of tests for audio. Unit tests: the route passes the secret to finish and fail and never puts it in a response body or log. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not touch exam locks (ticket 36), webhooks, or sessions. Do not add a service-role key to the app.

<!-- ralph 2026-11-06T00:40:30.076Z: committed + tests pass -->
