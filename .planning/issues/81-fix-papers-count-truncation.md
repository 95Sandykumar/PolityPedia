---
id: 81-fix-papers-count-truncation
status: todo
type: afk
depends_on: []
---
# Fix: papers question counts are wrong when a teacher has many papers (ticket 66 review finding)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. Strings in EN and HI through the existing i18n file. Review of ticket 66 found `progress.ts` fetches every live question row and counts them in JS. The API caps a response (often 1000 rows) and a paper can have 200 questions, so a teacher with about 6 full papers gets truncated rows. A later paper then shows 0 and hides Practice although it has questions.

## Definition of done
The question count per paper is correct for a teacher with 10 papers of 200 questions each. The count is made in the database, under the same row-level rules as today. A failed read still leaves progress unknown and keeps Practice.

## Vertical slice
- db or service: count per paper in the database (a SQL view or function with group by paper_id that stays under RLS, or one count request per paper). Do not fetch all question rows.
- UI: no change except it now gets the right numbers.

## Test that proves it
A fixture with more than 1000 live question rows across papers: every paper shows its exact count. A paper with 0 questions still hides Practice. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these)
- `web/src/lib/papers/progress.ts` (the fetch near lines 84 to 92)
- `web/src/lib/papers/__tests__/` (the progress test)
- `web/src/components/papers-list.tsx` (only to see what it needs)
- If you need a migration, use **0056** (0042 to 0054 are reserved by other tickets). Check `ls web/supabase/migrations | tail -3` first.
- Do not grep the whole repo. Do not `cat` whole files.

## Notes / scope guard
Do not change the papers list design. Do not touch teacher screens.
