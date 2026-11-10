---
id: 67a-teachers-reader-filter
status: todo
type: afk
depends_on: []
---
# Teachers list reader: exam filter and free-sample flag (service and tests, no screens)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. This is the first half of ticket 67. It was split because the whole of 67 hit the memory cap three times. Ticket 67 builds the screens on top of this reader. This ticket may own migration **0050**; create it only if a view is truly needed. DB tests use PGlite. Do not apply migrations to the live database.

## Definition of done
The teachers reader returns approved teachers with a free-sample flag. It can filter to teachers who teach the student's chosen exams, or return all. Order: teachers with a free sample first, then A to Z. The flag is true only for a LIVE set with a free sample test (draft and archived sets do not count). One query for the whole list, never one per teacher (B8). Never expose draft sets or real names behind an alias.

## Test that proves it
Reader tests: filter on and off, sort order, badge only for live sets. A PGlite test for the view if one is added (rollback note at the top of 0050). `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- `web/src/lib/teachers/supabase-teachers-client.ts`, `web/src/lib/teachers/types.ts`, `web/src/lib/teachers/public-teacher.ts`
- Its tests: `web/src/lib/teachers/__tests__/`
- Exam choice: `web/src/lib/exams/types.ts`, `web/src/lib/exams/supabase-exams-client.ts`, `web/src/lib/teacher-exams/types.ts`
- Schema for reference only: `web/supabase/migrations/0005_teachers.sql`, `web/supabase/migrations/0007_teacher_exams.sql`
- Do not open any component, page or `i18n.ts`. Do not grep the whole repo.
- Work order: 1) failing reader test, 2) reader (and view only if needed), 3) full checks. Commit after each step.

## Notes / scope guard
No screens, no i18n. No ratings, no search, no student counts.
