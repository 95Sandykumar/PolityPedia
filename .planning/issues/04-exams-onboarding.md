---
id: 04-exams-onboarding
status: done
type: afk
depends_on: [03-sign-in]
---
# Exams table and student onboarding (pick exams + language)

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A new student picks one or more exams and a language (English, Hindi or Both) on first sign-in. Later they change the language in Me > Language. The choice follows them to every device.

## Vertical slice
- Migration `0004_exams.sql`: `exams` (id, code, name_en, name_hi, marks_correct, marks_wrong, duration_min, question_count). Seed: UGC NET Political Science (+2 / 0, flagged unverified AS5), CUET PG Political Science HUQP18 (+4 / -1, 90 min, 75 Q), PGT Political Science, TGT Social Science (marking null until known). `student_exams` (user_id, exam_id) PK both, RLS own rows. Exams readable by all signed-in users.
- Onboarding screen after first sign-in: exam chips (multi-select), language 3-way choice, Continue.
- Me tab: Language setting (same 3 choices). Saved to `profiles.lang`. This is the ONLY language toggle (DESIGN.md D6). No toggle in the top bar.

## Test that proves it
`npm test`: RLS: student reads only own `student_exams`; onboarding component saves 2 exams + `hi` through the data interface; Me > Language updates `profiles.lang`.

## Design constraints
- DESIGN.md D6: one language toggle in Me > Language + first sign-in only.

## Notes / scope guard
No teacher list yet.
