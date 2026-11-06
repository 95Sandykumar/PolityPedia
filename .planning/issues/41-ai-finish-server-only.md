---
id: 41-ai-finish-server-only
status: done
type: afk
depends_on: []
---
# Fix: only the server can finish or fail an AI claim (review finding N1, MEDIUM)

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. SQL migrations live in `web/supabase/migrations/`. Name yours `0040_ai_finish_server_only.sql` (0039 is the last one). DB tests use PGlite through `web/test/db.ts` (`db.asUser`, `db.admin`). Claude and Supabase network calls are faked in tests.

The real Supabase project now exists, so a server-only key exists. The web app already needs `SUPABASE_SERVICE_ROLE_KEY` on the server for the Razorpay webhook (`src/lib/purchases/supabase-webhook-store.ts`, `src/lib/ledger/supabase-reconcile-store.ts`). Reuse that same pattern. Do NOT use the key in any file under a client component, and never log it.

## What is wrong (re-confirm with a failing test FIRST)
`claim_ai_explanation` (0038) hands the claimant a one-time secret. But `finish_ai_explanation`, `fail_ai_explanation`, `finish_explanation_audio` and `fail_explanation_audio` are all `grant execute ... to authenticated`. A user on the AI plan can call `rpc/claim_ai_explanation` from the browser (REST), receive their OWN secret, then call `rpc/finish_ai_explanation` with text and sources THEY wrote. That text is saved and every student then reads it. It costs them 1 of their 30 daily calls. The same applies to audio.

## Definition of done
1. A new migration revokes `execute` on the four functions from `public`, `anon` and `authenticated`, and grants it to `service_role` only. `claim_ai_explanation` and `claim_explanation_audio` stay callable by `authenticated` (the daily limit and the exam lock live there).
2. The four functions no longer rely on `auth.uid()` (a service-role call has none). They find the row by `(question_id, lang)` and the secret: the stored sha256 hash must match the secret passed in, and the secret is now REQUIRED (a NULL or wrong secret returns false, never an error that leaks anything). The refund in `fail_*` goes to the `claimed_by` / `audio_claimed_by` user stored on the row, exactly once, on the India day it was charged. Keep every other rule from 0037 and 0038 (takeover row lock, old secret dead after takeover, secret cleared on success, no refund twice).
3. The routes keep the secret in server memory only. `src/lib/ai/supabase-ai-client.ts` and `src/lib/ai/supabase-audio-client.ts`: `claim` still uses the user's token; `finish` and `fail` call Supabase with the service-role key through a small helper (new file, lazy env read inside a function so `npm run build` and `npm test` work with no env set). When the key is not set, `finish` and `fail` must throw a clear error that the route turns into the normal failure path (the student gets "try again", the call is refunded by the stale-claim rule). Never fall back to the user's token.
4. Update the fakes, types, and every caller. The revision screen, the teacher edit and the audio flow keep working.
5. Add `SUPABASE_SERVICE_ROLE_KEY=` (empty, with a comment: server only, never `NEXT_PUBLIC_`) to `web/.env.example` if that file exists, and mention it in `web/CLAUDE.md` where env keys are listed.

## Test that proves it
PGlite tests, each failing before the fix: as an authenticated user, `finish_ai_explanation`, `fail_ai_explanation`, `finish_explanation_audio` and `fail_explanation_audio` are refused with a permission error even with a valid secret; as the service role with the right secret, finish saves once, a second finish saves nothing, fail refunds once and a second fail refunds nothing; a wrong or NULL secret changes nothing; a stale takeover by user B refunds A exactly once and A's old secret is dead. Unit tests: with the key set, the client sends the service key (not the user token) on finish and fail and sends the user token on claim; with no key set, finish and fail throw; the secret and the key never appear in a response body or log. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not change the exam locks (0030, 0036, 0037), webhooks, sessions, or the claim functions' limits. Do not add the key to any `NEXT_PUBLIC_` variable. Do not touch `.env.local`.

<!-- ralph 2026-11-06T20:55:42.204Z: committed + tests pass -->
