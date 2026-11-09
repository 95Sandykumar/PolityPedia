---
id: 54a-read-error-core
status: todo
type: afk
depends_on: []
---
# Read errors, part 1: result type, shared error component, mock list and papers list

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. This is the first part of ticket 54 (visible read errors). Ticket 54 was split because the whole of it failed twice on the memory cap and once on tests. Ticket 54 finishes the other screens on top of this core. DB tests use PGlite. Do not apply migrations. New strings in EN and HI through the existing i18n file.

Today the student readers swallow every failure with `.catch(() => [])` or `if (!res.ok) return []`. A missing database column showed "No mock tests yet. Your teacher adds them soon." while the content existed.

## Definition of done
1. A small shared type separates "ok but empty" from "failed" for a student read (name it in one new file, for example `web/src/lib/read-result.ts`).
2. One shared error component (plain message plus a Retry button) with EN and HI strings. The message names no table, column or key.
3. The mock list and the papers list use them: a failed read (HTTP error or thrown error) shows the error state and never the empty-state text. A read that succeeds with zero rows still shows the empty-state text.

## Test that proves it
For the mock list reader and the papers list reader: a 400 gives the error state, a 200 with `[]` gives the empty state. One test reproduces the original bug: a response saying the column `archived_at` does not exist gives the error state, not "No mock tests yet". A component test for Retry. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- `web/src/components/mock-list.tsx`, `web/src/components/papers-list.tsx`
- `web/src/app/(student)/_data/student-ui-data.ts`
- `web/src/lib/set-access/student-page.ts`
- `web/src/components/student-ui.tsx` (only to see where to put the shared component and the prefetch link wrapper pattern)
- `web/src/lib/i18n.ts` (add keys only)
- Find the exact reader function for each list with `grep -n "catch(() =>\|res.ok" ` inside those files only.
- Do NOT touch: `web/src/lib/*/supabase-*-client.ts`, any `teacher-page.ts`, `web/src/app/teacher/**`, `web/src/components/exam-player.tsx`
- Work order: 1) result type, 2) mock list reader plus its test, 3) shared error component plus its test, 4) papers list, 5) full checks. Commit after each step.

## Notes / scope guard
Do not change what any query selects. No alerts (ticket 55). Do not touch teacher screens or the other student screens: ticket 54 does those.
