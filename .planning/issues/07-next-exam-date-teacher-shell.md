---
id: 07-next-exam-date-teacher-shell
status: todo
type: afk
depends_on: [06-portfolio-follow]
---
# Teacher dashboard shell and next exam date

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher opens their dashboard (sidebar on laptop, bottom nav on phone: Home, Papers, Mock sets, Batches, Profile), sets the next exam date for each of their exams, and students see a pill 'Next exam: NET 18 Dec' on the portfolio.

## Vertical slice
- Migration `0007_teacher_exams.sql`: `teacher_exams` (teacher_id, exam_id, next_exam_date, label) PK (teacher_id, exam_id). Teacher writes own rows; signed-in users read.
- Teacher layout `/teacher/*` with the 5 slots. Profile page: pick exams + date per exam.
- Portfolio header shows the nearest future date as a pill.

## Test that proves it
`npm test`: teacher A cannot edit teacher B's dates; pill shows the nearest future date and hides past dates.

## Design constraints
- V7: each teacher keeps the next exam date per exam.

## Notes / scope guard
Placeholder pages for Papers, Mock sets, Batches.
