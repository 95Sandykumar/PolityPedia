---
id: 32-ai-claim-tokens
status: done
type: afk
depends_on: []
---
# Security fix: only the user who claimed an AI explanation can finish or fail it

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Every outside service (Claude, TTS, Supabase network) is faked in tests. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (this one: `0032_ai_claim_tokens.sql`). RLS is on for every table. DB tests use PGlite through `web/test/db.ts`. Labels exist in English and Hindi in `web/src/lib/i18n.ts`.

This is a SECURITY FIX from the 2026-11-05 code review. Tickets 22 (revision API), 23, 24 and 25 (audio) built the AI explanation flow.

## What is wrong (re-confirm by reading)
- `0022_ai.sql:280` `finish_ai_explanation`, `:349` `fail_ai_explanation` (refund at `:381`), and `0025_revision_audio.sql:178` `finish_explanation_audio` (and `claim_explanation_audio`) only check `auth.uid() is not null`. They are SECURITY DEFINER and granted to `authenticated`.
- Cost bypass: an AI-plan user calls `/api/revision` (claim, count +1), then during the model call calls `fail_ai_explanation` over REST. That refunds the count and marks the row `failed`. They repeat. Every cycle spends a Claude call and the 30 a day cap never fills.
- Poisoning: a user with no plan polls a `generating` row and calls `finish_ai_explanation` with their own body and `sources`. That text becomes the permanent saved explanation for every student.
- `sources[].url` is only scheme-checked on the Claude path (`src/lib/ai/anthropic-explainer.ts:125`). `src/lib/ai/explanation-row.ts:38-47` and `src/components/revision-panel.tsx:349` render stored URLs without a check, so a `javascript:` or phishing link can be served.
- Audio: any user can `claim_explanation_audio` and never finish (stuck `audio_status='making'`), or call `finish_explanation_audio` with any `audio_path`.
- `claim_ai_explanation` checks only that the question is live. It does not check that the user has access to the test, and it reveals the correct option in the prompt even if the user has an OPEN exam sitting on that test (ticket 30 locks the key in the database; here the AI route must also refuse while an exam sitting is open for that question's test).
- A `generating` row can stay stuck forever if the function dies (no timeout, no sweeper, no `maxDuration`).

## Definition of done
1. A claim carries an owner: store `claimed_by` and `claimed_at` on `ai_explanations` (and the audio claim). `finish_*` and `fail_*` only act when `auth.uid() = claimed_by` and the row is still `generating`/`making`. Anyone else gets a refusal.
2. A refund happens only when the model call failed before any text was produced. Never refund after a successful `finish`.
3. `claim_ai_explanation` takes over a `generating` row older than 2 minutes (and refunds the first claimant's count once). `/api/revision` exports `maxDuration`.
4. `claim_ai_explanation` checks `has_test_access()` for the question's test and refuses while the user has an open exam sitting for that test.
5. Source URLs: only `http` and `https` are stored and rendered. Enforce in SQL (CHECK or normalisation inside `finish_ai_explanation`) and in the render path.
6. `finish_explanation_audio` accepts only an `audio_path` under the expected folder for that explanation id, and only from the claimant.

## Vertical slice
- Migration `0032_ai_claim_tokens.sql` (new columns, replaced functions, same names so callers keep working; keep `set search_path = public`).
- Update `src/lib/ai/` callers if signatures change. Keep the revision screen and teacher edit working.

## Test that proves it
PGlite DB tests with `asUser`: user B calls `finish_ai_explanation` / `fail_ai_explanation` / `finish_explanation_audio` on user A's claim: refused. Claimant can finish. Fail refunds once, finish never refunds. A stale `generating` row (age > 2 min) is taken over. A `javascript:` source is rejected. A user without test access cannot claim. A user with an open exam sitting cannot claim for that test. Unit tests for the render-path URL check. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not change the answer-key storage (ticket 30) or the attempts table (ticket 31). Do not touch payments.
