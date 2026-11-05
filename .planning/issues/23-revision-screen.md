---
id: 23-revision-screen
status: blocked
type: afk
depends_on: [22-revision-api]
---
# Revision screen and the player's Revision button

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
From a wrong answer, a student taps Revision (AI) and sees the explanation: Exam and Topic chips, the question in short, sections with headings, a Remember box, and Sources. A student without a plan sees a card 'AI explanation Rs 100/month' and the teacher explanation stays visible. At the limit they see '30 new explanations used today. Saved ones still work.'

## Vertical slice
- Revision page/panel. Loading: skeleton + 'Writing explanation...' with `aria-busy`. A second student waits on the `generating` row through the `Live` interface (no polling).
- Thumbs up/down: migration `0023_ai_feedback.sql` (`ai_feedback` (user_id, question_id, lang, vote)).
- Wire the player's Revision (AI) button (replaces 'Coming soon').

## Test that proves it
`npm test`: ready state renders sections + sources; no-plan state shows the upsell card and the teacher explanation; limit state shows the message; generating state updates when the fake Live pushes ready.

## Design constraints
- DESIGN.md section 8 Revision (AI). B6: push, not polling.

## Notes / scope guard
The upsell button can link to a placeholder plan page until issue 28.

<!-- ralph 2026-11-05T18:52:21.334Z: upstream 22-revision-api blocked -->
