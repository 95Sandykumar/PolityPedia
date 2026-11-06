---
id: 36-exam-leaks-close
status: done
type: afk
depends_on: []
---
# Fix: close the four ways a student still gets the answer during an exam

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Every outside service is faked in tests. SQL migrations live in `web/supabase/migrations/`. Name yours `0037_exam_leaks_close.sql` (0036 is taken by `0036_practice_verdict_reads_key.sql`). DB tests use PGlite through `web/test/db.ts` with `db.asUser`. Labels exist in English and Hindi in `web/src/lib/i18n.ts`.

This is a SECURITY FIX. Tickets 30 (`0030_exam_key_lock.sql`) and 31 were built, and an independent reviewer then PROVED with PGlite probes that the key still leaks. "Open exam" means `public.has_open_exam(test_id)` (0030:70).

## What is wrong (re-confirm each by writing the failing test FIRST)
1. DELETE the open exam sitting. `attempts_delete_own` (`0013_attempts.sql:105`) lets a student delete their own unsubmitted exam attempt. Then `has_open_exam()` is false, `question_keys()` returns the key, and a fresh exam can be started with a new deadline. The same hole defeats `practice_verdict()` (0036) and the practice-insert policy.
2. `questions.teacher_explanation` is still readable (0030 revoked only `correct_idx`). `src/lib/exam/types.ts:91` itself lists it as a key field. A student can `GET /rest/v1/questions?test_id=eq.X&select=number,teacher_explanation` mid-exam and read "Option C is right".
3. Saved AI explanations are readable mid-exam. `ai_explanations_select_visible` (`0022_ai.sql` near line 409) only checks that the question is visible, and the text quotes the correct option. `claim_explanation_audio` (0032) also has no open-exam check, so audio of a ready explanation is available.
4. `claim_ai_explanation` (0032, near lines 245-256) treats an exam as open only while `now() < deadline_at`. `has_open_exam` does not. After the deadline with no submit, claim is allowed but `question_keys` stays locked. Use `has_open_exam()` in both.

## Definition of done
1. A student cannot delete an attempt with `mode = 'exam'` and `submitted_at is null` (restrictive delete policy, or revoke delete and give a definer function if the app needs one; check what app code deletes attempts and keep it working). Admin and cascade from user delete still work.
2. `teacher_explanation` is not readable by `anon`/`authenticated` from `questions` during an open exam of that test. Preferred design, following 0030: revoke the column privilege and add a definer function `question_explanations(uuid[])` with the same read rules and the same open-exam refusal as `question_keys()` (teachers always read their own). Update every reader (`src/lib/questions/rows.ts` QUESTION_COLUMNS, `supabase-questions-client.ts`, `src/lib/split/supabase-split-store.ts`, `src/lib/ai/supabase-ai-client.ts`, `src/lib/ai/explanation-row.ts`, and any student view that shows the explanation after answering) so teachers and normal practice and results still work.
3. `ai_explanations` select (and the audio claim) is refused while the caller has an open exam for that question's test (restrictive select policy; teachers who own the question are exempt).
4. `claim_ai_explanation` and `claim_explanation_audio` use `has_open_exam()` for the exam check, with no deadline clause.

## Test that proves it
PGlite tests with `asUser`, each failing before the fix: delete of an open exam refused, and `question_keys` still refused afterwards; keys open after submit; `select teacher_explanation` mid-exam refused for a student, allowed for the owning teacher, allowed after submit; `question_explanations` refuses mid-exam; `ai_explanations` select returns zero rows mid-exam and rows after submit; claim after the deadline with no submit is refused. Existing tests still pass (`practice-verdict`, `exam-key-lock`, `attempt-score-guard`, the AI and question tests). `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not change refunds or claim secrets (ticket 37), webhooks, or session code. If a reader needs the explanation for a student after a practice answer, that must keep working outside an open exam.

<!-- ralph 2026-11-06T00:15:47.940Z: committed + tests pass -->
