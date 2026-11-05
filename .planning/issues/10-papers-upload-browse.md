---
id: 10-papers-upload-browse
status: done
type: afk
depends_on: [07-next-exam-date-teacher-shell]
---
# Past papers: teacher upload and student browse (Exam > Year > Month)

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher uploads a past paper PDF (questions, solutions or both) with exam, year and optional month. Students browse Exam > Year > Month > paper and download the PDF. Students see only live papers.

## Vertical slice
- Migration `0010_papers.sql`: `papers` (id, teacher_id, exam_id, year, month NULL, label, pdf_questions_path, pdf_solutions_path, status draft/live) UNIQUE (teacher_id, exam_id, year, month, label).
- `FileStore` interface (upload, signed download URL) with a fake for tests. Max 30 MB per PDF, checked in the browser and on the server.
- Teacher Papers page: upload form + list. Student `/t/[id]/papers`: grouped list, download button.

## Test that proves it
`npm test`: student sees only live papers; teacher B cannot read teacher A's drafts; a 31 MB file is refused; grouping by exam, year, month is right.

## Design constraints
- V8: per teacher copy; past papers are free. Limits: 30 MB per PDF.

## Notes / scope guard
No AI split (issues 11, 12). No publish button yet: publish comes in issue 11.

<!-- ralph 2026-11-05T17:47:34.907Z: committed + tests pass -->
