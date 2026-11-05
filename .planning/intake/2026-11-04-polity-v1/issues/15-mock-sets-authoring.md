---
id: 15-mock-sets-authoring
status: todo
type: afk
depends_on: [11-ingest-job-review-publish]
---
# Teacher creates and prices mock sets

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher creates a mock set for an exam, adds tests (Test 1 can be a free sample), adds questions, sets the price with a stepper from Rs 299 to Rs 399, sees 'You get about Rs X per sale', and publishes.

## Vertical slice
- Migration `0015_mock_sets.sql`: `mock_sets` (id, teacher_id, exam_id, title, price_inr CHECK BETWEEN 299 AND 399, status draft/live), `mock_tests` (id, set_id, title, position, duration_min, is_free_sample). Add FK `questions.test_id -> mock_tests.id`.
- Teacher Mock sets pages: set form, tests list, questions (reuse the review form from issue 11 with test_id), publish.
- Price stepper in steps of Rs 10, numeric keypad. Estimate line = price / 1.18 (GST inside) x 0.98 (gateway, estimate) x share / 100, rounded down, labelled 'about'.

## Test that proves it
`npm test`: price 298 and 400 rejected by the DB; estimate for Rs 399 at 50% = Rs 165; teacher B cannot edit teacher A's set; only position 1 can be a free sample.

## Design constraints
- V11: price Rs 299 to Rs 399 chosen by the teacher. X3 default: share on net. AS6: GST 18% inside price, fee ~2% (unverified).

## Notes / scope guard
No payments (issues 26, 27). No batch grants (issue 19).
