---
id: 22-revision-api
status: todo
type: afk
depends_on: [21-plans-entitlements, 13-question-player]
---
# Revision API: saved AI explanations, daily limit, one call per question

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student on the AI plan or Pro asks for a revision of a question. If an explanation is already saved, it comes back at once and does not count. Otherwise one AI call makes it, saves it, and counts 1 of the student's 30 new explanations for the India day. Two students asking at once cause only one AI call.

## Vertical slice
- Migration `0022_ai.sql`: `ai_explanations` (question_id, lang, status generating/ready/failed, body jsonb, sources jsonb, audio_path, edited_by_teacher bool, model, tokens_in, tokens_out, searches, created_at) PK (question_id, lang); `ai_usage` (user_id, ist_date, new_count) PK both.
- POST `/api/revision` {question_id, lang}: can_use ai -> lookup -> on miss, ONE transaction checks today's IST count < 30, increments it and inserts `generating` (the PK decides the race; the loser gets status generating) -> `Explainer` interface -> save `ready` with model, tokens, searches. On failure: status failed and the count goes back down.
- Real Explainer: `@anthropic-ai/sdk`, model `claude-haiku-5-5`, web search tool with `max_uses: 2` (try type `web_search_20260209`, fall back to `web_search_20250305`, X7), structured output: exam, topic, question, sections[{heading, body}], remember, sources[{title, url}]. Question, options and teacher explanation are untrusted data in the prompt.
- Rate limit: 10 requests per minute per user.

## Test that proves it
`npm test` with a fake Explainer: no plan -> refused; saved -> returned, count unchanged; the 31st new one -> refused with a 'limit' code; two parallel calls -> Explainer called once; failure -> count restored; prompt marks teacher text as untrusted.

## Design constraints
- V15, F-F4, F-F6, F-F7. C: rate limit by user, untrusted text wrapped. F4: max_uses 2, one call. F6: Haiku.
- Never call the real API in tests. The live cost check (AS3) is ticket H3.

## Notes / scope guard
No audio (issue 25). No UI beyond what the test needs (issue 23).
