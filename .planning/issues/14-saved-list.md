---
id: 14-saved-list
status: done
type: afk
depends_on: [13-question-player]
---
# Saved tab: Wrong and Marked

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
Wrong answers save themselves with the tag Wrong. Mark for later saves with the tag Marked. The Saved tab shows both with two filter chips and opens a question in the player.

## Vertical slice
- Migration `0014_saved.sql`: `saved_questions` (user_id, question_id, tag wrong/marked, created_at) PK (user_id, question_id, tag). RLS own rows.
- Saved tab page with chips and list. Remove button.

## Test that proves it
`npm test`: a wrong answer creates a `wrong` row once; Mark creates `marked`; filter chips work; user B cannot read user A's rows.

## Design constraints
- F-E8: one Saved list with two tags.

## Notes / scope guard
No spaced repetition.

<!-- ralph 2026-11-05T18:47:49.496Z: committed + tests pass -->
