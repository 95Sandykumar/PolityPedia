---
id: 30-exam-key-lock
status: done
type: afk
depends_on: []
---
# Security fix: the exam answer key must not be readable during an exam

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Every outside service is behind a small interface and faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (this one: `0030_exam_key_lock.sql`). RLS is on for every table. DB tests use PGlite through the helper `web/test/db.ts`. Every label a user sees exists in English and Hindi through `web/src/lib/i18n.ts`.

This is a SECURITY FIX from the 2026-11-05 code review of the finished v1 app. Ticket 18-exam-mode promised that the answer key (`questions.correct_idx`) never reaches the student during an exam (F-E5). It is only hidden in app code. The database still returns it.

## What is wrong (confirmed by the reviewer, re-confirm by reading)
- `supabase/migrations/0011_questions.sql` (~line 218) and `0016_set_access.sql` (~line 164): a student with set access can `select` the `questions` table, including `correct_idx`.
- Scenario A: the student calls `GET {SUPABASE_URL}/rest/v1/questions?test_id=eq.<id>&select=number,correct_idx` with the anon key and their own token, in the middle of a timed exam.
- Scenario B: while the exam timer runs, the student opens `/t/<teacherId>/mocks/<testId>/play?mode=practice` for the same test in another tab. Practice mode ships the key by design. The "one open sitting" unique index includes `mode`, so an exam sitting and a practice sitting coexist.
- The stripping happens only in `web/src/lib/exam/student-page.ts` (`examQuestions`) and `web/src/app/(student)/t/[teacherId]/mocks/[testId]/play/page.tsx`.

## Definition of done
While a student has an OPEN exam sitting (not submitted, deadline not passed) for a test, that student cannot read `correct_idx` for any question of that test through any database route, and cannot start or play a practice sitting for that test. After they submit, everything works as before.

## Vertical slice
- Migration `0030_exam_key_lock.sql`. Pick the smallest design that makes the database itself refuse. Suggested: stop `authenticated` reading `correct_idx` directly (column privilege or a view), and give students the key only through a SECURITY DEFINER function with `set search_path = public` that checks `auth.uid()`, set access via `has_test_access()`, and refuses while that user has an open exam sitting for the test. Teachers must still read and edit `correct_idx` for their own questions (ticket 11, 24 screens). The practice player and the AI explainer keep working outside an open exam.
- `score_attempt()` keeps reading the key itself (it is SECURITY DEFINER). Do not break it.
- App code: practice start and `/api/tests/[id]/load` refuse `mode=practice` while an open exam sitting exists for that test. Show a plain bilingual message.
- Update every place that selected `correct_idx` as the student so it uses the new route.

## Test that proves it
DB tests in `web/test/` with PGlite and real RLS (`asUser`): (1) student with an open exam sitting selects `correct_idx` directly: refused or null. (2) Same student calls the new function: refused. (3) After `score_attempt` submits the sitting: allowed. (4) Student with NO open exam sitting can use practice and see the key. (5) A teacher still reads and updates `correct_idx` on their own question. (6) Another teacher cannot. (7) Starting a practice sitting while an exam sitting is open is refused. `npm test`, `npm run typecheck` and `npm run build` all pass.

## Design constraints
- F-E5: the phone is never given the key during an exam.
- Do not change the exam or practice screens' look. Messages use the i18n dictionary in both languages.

## Notes / scope guard
Only the key lock and the practice-while-exam block. The AI explanation function is ticket 32. Do not touch payments.
