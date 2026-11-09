---
id: 49-subjects-and-topics
status: todo
type: afk
depends_on: [45-keep-money-and-scores, 55-schema-guard-and-read-alerts, 59-start-screen-and-submit-confirm, 61-block-second-order, 62-prepay-card-and-my-purchases]
---
# Subjects and topics: tag every mock test and every question

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` sections 4 and 6. DB tests use PGlite. This ticket owns migration **0045** only.

Today: `questions.topic_id uuid` (`0011_questions.sql:136`) points at nothing. `mock_tests` has no subject. Marking comes from `exams.marks_correct/marks_wrong` in `score_attempt()` (`0018_exam_mode.sql`).

## What to build
1. `0045_subjects_topics.sql` (rollback note): tables `subjects(id, exam_id, name_en, name_hi, position)` and `topics(id, subject_id, teacher_id null, name_en, name_hi, position)`; `teacher_id null` = platform list, set = a teacher's own topic (only they see and use it). FK `questions.topic_id -> topics on delete set null`; add `questions.subject_id`. On `mock_tests`: `kind in ('full','subject','topic') default 'full'`, `subject_id`, `topic_id`, `marks_correct numeric null`, `marks_wrong numeric null` (null = exam default). Update `score_attempt()` to prefer the test override, keeping its existing safety rules (never pay for a wrong answer, zero scheme -> one mark). Keep the function's existing contract and comments.
2. Seed: UGC NET Political Science Paper 2 units and CUET PG Political Science topics. Use the official syllabus names; if you cannot verify a name from a file in the repo (`research/`, `web/papers-import/`), mark the seed comment "UNVERIFIED syllabus list" and keep it short (units only). Hindi names may be left null.
3. Teacher UI in the existing mock set editor (`/teacher/mocks/[setId]`): per test, pick kind + subject/topic + marks override; per question, subject and topic dropdowns (search box), "Add my own topic". Past paper review screen gets the same per-question tags.
4. Student mock list: filter chips Full / Subject / Topic and a subject dropdown (the sketch's "full paper or topic dropdown").

## Test that proves it
PGlite: teacher topic invisible to other teachers; question cannot point at another teacher's private topic (trigger); `score_attempt()` uses override when set and exam default when null; existing exam-mode tests still pass unchanged. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No sections inside one test (Upcoming). Do not apply the migration live.

<!-- ralph 2026-11-09T18:51:51.036Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.182Z: upstream 56-result-page blocked -->
