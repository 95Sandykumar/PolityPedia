---
id: 13-question-player
status: todo
type: afk
depends_on: [11-ingest-job-review-publish]
---
# Question player (past papers) with same-screen result

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student opens a live past paper and answers questions one by one: progress bar with '12 / 100', 4 outline options, Reveal answer, Mark for later, Next. After a tap, the result shows on the same screen under the options: Wrong (cross icon) with the right option green and the chosen one red, Teacher explanation (closed), Revision (AI), Next; or Correct (check icon), Mark for later, Next.

## Vertical slice
- Migration `0013_attempts.sql`: `attempts` (id, user_id, paper_id NULL, test_id NULL, mode practice/exam, topic_id NULL, started_at, deadline_at, submitted_at, score) and `attempt_answers` (attempt_id, question_id, chosen_idx, is_correct, marked, answered_at) PK (attempt_id, question_id). RLS own rows.
- Player component shared with mock tests later. All questions load in 1 request. Answers write browser -> Supabase through the data interface (upsert). Offline: banner 'No internet. Answers are saved and sent when back.' and a retry queue.
- Revision (AI) button visible but shows 'Coming soon' until issue 23.
- A11y: options are real buttons, result announced with `aria-live=polite`, 56 px options.

## Test that proves it
`npm test`: answering the same question twice keeps one row (upsert); wrong state shows right option + chosen option + accordion closed; correct state shows Mark for later + Next; offline queue retries after reconnect (fake).

## Design constraints
- DESIGN.md section 8 player + D3 (same screen). Colour never alone: icon + word. A1: upsert is idempotent.

## Notes / scope guard
Practice and exam modes for mocks are issues 17 and 18.
