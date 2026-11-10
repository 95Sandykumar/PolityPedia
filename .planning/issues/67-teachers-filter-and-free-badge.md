---
id: 67-teachers-filter-and-free-badge
status: done
type: afk
depends_on: [67a-teachers-reader-filter]
---
# Teachers list uses the student's exam and shows the free sample (screens only)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gaps 6, 8, 10 and steps 6, 7. This ticket may own migration **0050**; create it only if a view is truly needed. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

The reader with the exam filter and the free-sample flag is built by ticket 67a: reuse it, do not rewrite it. This ticket is the screens. Today the Teachers list shows every approved teacher A to Z. The exam a student picked at onboarding is never used. Nothing says a teacher has a free test.

## Definition of done
1. The Teachers list shows teachers who teach the student's chosen exams by default, with a "Show all" switch. Teachers with a free sample come first.
2. A card shows a "Free sample" badge when the teacher has a live set with a free sample test. The teacher page Mocks tile shows the same badge.
3. If a view is needed to read the badge cheaply, add `0050_teacher_free_sample.sql` (rollback note at the top). If not needed, create no migration.

## Vertical slice
- UI: filter switch ("Show all"), badge on cards and on the teacher page Mocks tile, using the reader from 67a
- i18n: EN and HI

## Test that proves it
Component tests: the switch is two LINKS, default shows the student's exams, "Show all" shows everyone; the badge shows on a card and on the tile only when the flag is true. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B8: one query for the list, never one per teacher. Never expose draft sets or alias real names.

## Notes / scope guard
No ratings, no search, no student counts.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- Reader from 67a: `web/src/lib/teachers/supabase-teachers-client.ts` and `web/src/lib/teachers/types.ts` (read the new function signature only)
- Screens: `web/src/components/teachers-list.tsx`, `web/src/app/(student)/teachers/page.tsx`, `web/src/app/(student)/t/[teacherId]/page.tsx` (the Mocks tile)
- Tests to copy the style of: `web/src/components/__tests__/teachers-list.test.tsx`
- Shared pieces: `web/src/components/student-ui.tsx` (prefetch link wrapper), `web/src/lib/i18n.ts` (add keys only)
- Do not open migrations. Do not grep the whole repo.
- Work order: 1) the list switch plus test, 2) the card badge plus test, 3) the tile badge, 4) i18n, 5) full checks. Commit after each step.

<!-- ralph 2026-11-10T03:50:31.872Z: committed + tests pass -->
