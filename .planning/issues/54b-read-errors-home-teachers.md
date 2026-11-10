---
id: 54b-read-errors-home-teachers
status: done
type: afk
depends_on: [54a-read-error-core]
---
# Read errors, part 2a: Home, Teachers list, teacher page counts

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Part of ticket 54 (visible read errors). Ticket 54a already built the shared result type and the shared error component (message plus Retry, EN and HI): reuse them, do not rebuild them. Find them with `git log --stat -5 -- web/src/lib web/src/components`, not by searching the repo. DB tests use PGlite. Do not apply migrations. New strings in EN and HI through `web/src/lib/i18n.ts`.

## Definition of done
When a read fails (HTTP error or thrown error) the screen shows the shared error state and never the empty-state text. A read that succeeds with zero rows still shows the empty-state text. The message names no table, column or key. Screens in this ticket: Home (followed teachers and notices), the Teachers list, and the tile counts on the teacher page.

## Test that proves it
For each of the three readers: a 400 gives the error state, a 200 with `[]` gives the empty state. A Retry test for one screen. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- Readers: `web/src/lib/follows/student-page.ts`, `web/src/lib/posts/server-posts.ts`
- Screens: `web/src/app/(student)/page.tsx`, `web/src/app/(student)/teachers/page.tsx`, `web/src/app/(student)/t/[teacherId]/page.tsx`
- Teachers list component: `web/src/components/teachers-list.tsx`
- Do NOT touch: `web/src/lib/*/supabase-*-client.ts`, any `teacher-page.ts`, `web/src/app/teacher/**`, `web/src/components/exam-player.tsx`, and the Saved, Practice, videos and news screens (ticket 54c)
- Work order: ONE screen per step (reader, screen, test), commit after each step, full checks last.

## Notes / scope guard
Do not change what any query selects. No alerts (ticket 55).

<!-- ralph 2026-11-10T02:32:21.409Z: committed + tests pass -->
