---
id: 11-ingest-job-review-publish
status: done
type: afk
depends_on: [10-papers-upload-browse]
---
# Split job row, teacher review screen, and publish

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
After upload, the teacher sees a live job status. When questions arrive as drafts, the teacher checks each one next to its PDF page, edits it, marks it Checked, and publishes. Publish stays off until every question is checked. Students never see drafts.

## Vertical slice
- Migration `0011_questions.sql`: `ingest_jobs` (id, teacher_id, paper_id, pdf_path, status queued/running/done/failed, attempts, error, question_count, created_at) and `questions` (id, teacher_id, paper_id NULL, test_id NULL, number, stem, options jsonb (exactly 4), correct_idx 0..3, teacher_explanation, topic_id NULL, lang, image_path, checked bool, status draft/live, CHECK exactly one of paper_id / test_id; the `test_id` FK is added in issue 15, keep it a plain uuid now).
- Upload from issue 10 now also inserts an `ingest_jobs` row (queued).
- Review screen: laptop two columns (PDF page left, form right); phone tab switch 'PDF | Question'. Job progress through a `Live` interface (Supabase Realtime in prod, fake in tests). No polling.
- SQL function `publish_paper(paper_id)`: refuses if any question is unchecked; sets paper + questions live in one transaction.

## Test that proves it
`npm test`: publish refused with one unchecked question; publish sets all live atomically; a student cannot read a draft question; teacher B cannot edit teacher A's questions; options must be exactly 4.

## Design constraints
- V9: nothing is live before teacher publish. B6: job status pushed, no fixed polling.
- Risk 1 (design.md): wrong answers from the split must not reach students before a teacher check.

## Notes / scope guard
The split itself is issue 12. A manual 'Add question' button is allowed here so the screen is testable.

<!-- ralph 2026-11-05T18:13:39.734Z: committed + tests pass -->
