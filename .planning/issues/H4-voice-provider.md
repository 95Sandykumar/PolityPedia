---
id: H4-voice-provider
status: todo
type: human
depends_on: [25-revision-audio]
---
# Boss: pick the voice provider (X5)

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
One voice provider is chosen for Hindi + English, its key is in `web/.env.local`, and a follow-up ticket to wire it is written.

## Vertical slice
- Try ElevenLabs (candidate) on one Hindi and one English explanation. Note the price per character.

## Test that proves it
Two sample files sound right to Boss.

## Design constraints
- X5.

## Notes / scope guard
Ralph wires the provider in a later ticket.
