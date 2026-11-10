---
id: 57a-review-reader
status: todo
type: afk
depends_on: [56-result-page]
---
# Review reader: the newest submitted sitting, read only (service and tests, no screens)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. First half of ticket 57 (review and retake). Split because ticket 57 hit the memory cap. Ticket 57 builds the screens on top of this reader. The result reader from ticket 56a (`web/src/lib/attempts/result.ts`) is the pattern to follow: reuse its types and helpers, do not duplicate them. DB tests use PGlite. Do not apply migrations to the live database.

## Definition of done
A function returns, for a test or paper, the signed-in student's newest SUBMITTED sitting with every question: the student's answer, the right answer and the explanation. It is read only: calling it never creates or changes an attempts row, in practice mode or exam mode. If there is no submitted sitting it returns nothing. Another student's sitting is never returned. Keys and explanations are returned only for a submitted attempt (0030 key lock).

## Test that proves it
PGlite: the attempts row count is unchanged after the reader runs in practice and exam mode. A student cannot read another student's sitting. No submitted sitting returns nothing. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- `web/src/lib/attempts/result.ts` and `web/src/lib/attempts/types.ts` (from 56a)
- `web/src/lib/attempts/supabase-attempts-client.ts`
- Test setup to copy from: `web/test/db.ts` and the new result test next to `web/src/lib/attempts/__tests__/`
- Do not open any component, page or `i18n.ts`. Do not grep the whole repo.
- Work order: 1) failing test, 2) reader, 3) full checks. Commit after each step.

## Notes / scope guard
No screens. No analytics, no sharing.
