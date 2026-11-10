---
id: 79-student-display-name
status: blocked
type: afk
depends_on: [53-teacher-basic-analytics]
---
# Student display name, shown in batch reports

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-3 gap 8 and step 17. This ticket owns migration **0054** only. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today the teacher's batch report shows a short user id because the app never collects a name.

## Definition of done
1. Onboarding asks for a name (2 to 40 characters). It can be skipped: then the report shows "Student" and a short id.
2. The name is stored in `profiles.display_name` (migration `0054_student_display_name.sql`, rollback note at the top). The student can edit it in Me.
3. The teacher's batch report (and the analytics from teacher ticket 53) show the name for members of that teacher's own batches only.
4. The join page line reads "Your teacher will see your name and scores."

## Vertical slice
- schema: 0054
- service: save and read name; report views use it
- UI: onboarding field, Me edit, report, join page text

## Test that proves it
PGlite: a teacher sees names only for members of their own batches; another teacher and other students do not. Length validation. Skip path. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
Privacy: ask for nothing else (no phone, no email, no photo). The name is never shown to other students.

## Notes / scope guard
Do not change `teachers_public`. No avatars.

<!-- ralph 2026-11-09T18:51:51.042Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.190Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.324Z: upstream 54-visible-read-errors blocked -->

<!-- ralph 2026-11-10T02:33:51.599Z: upstream 54c-read-errors-saved-practice-media blocked -->
