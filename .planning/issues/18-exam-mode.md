---
id: 18-exam-mode
status: todo
type: afk
depends_on: [17-practice-mode]
---
# Timed exam mode: answer key hidden until submit

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student starts a test in Exam mode. A timer runs (turns amber under 5 minutes). They jump between questions with the progress bar and a number grid. No answer is shown until they submit. After submit the score is computed on the server and the review shows answers and explanations.

## Vertical slice
- Route `/api/tests/[id]/load?mode=exam`: returns questions WITHOUT `correct_idx` and `teacher_explanation`. Creates the attempt with `deadline_at = now + duration`.
- RLS: `attempt_answers` insert/update only while `now < deadline_at` and `submitted_at` is null.
- SQL function `score_attempt(attempt_id)`: marks per exam, sets `submitted_at` + `score`, safe to call twice.
- Player: timer top right, tap the progress bar to open the number grid (answered, marked, not seen) (DESIGN.md D2).

## Test that proves it
`npm test`: the exam load payload contains no `correct_idx` and no `teacher_explanation` (key test); a write after the deadline is refused; +4/-1 scoring is right; calling submit twice gives the same score.

## Design constraints
- F-E5: the answer key never reaches the phone before submit. Exam mode key: strip until submit (design.md trade-offs).

## Notes / scope guard
No proctoring, no tab-switch detection.

<!-- ralph 2026-11-05T18:44:34.420Z: upstream 15-mock-sets-authoring blocked -->
