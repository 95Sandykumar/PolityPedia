---
id: 17-practice-mode
status: todo
type: afk
depends_on: [16-set-access-mock-list, 13-question-player]
---
# Practice mode for mock tests

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student starts a mock test in Practice mode (full paper or one topic), sees right or wrong after each question in the shared player, and gets a score at the end. The mock list then shows a tick and the score.

## Vertical slice
- Start route creates an `attempts` row (mode practice, topic filter). Reuse the player. Score with the exam's marks from `exams`.
- Mock list reads the latest submitted attempt per test.

## Test that proves it
`npm test`: topic filter loads only that topic's questions; score uses marks_correct / marks_wrong; list shows tick + score after submit.

## Design constraints
- F-E4 practice mode. F-E6 marking per exam.

## Notes / scope guard
Timed mode is issue 18.

<!-- ralph 2026-11-05T18:44:34.419Z: upstream 15-mock-sets-authoring blocked -->
