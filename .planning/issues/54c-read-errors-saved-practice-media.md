---
id: 54c-read-errors-saved-practice-media
status: done
type: afk
depends_on: [54a-read-error-core]
---
# Read errors, part 2b: Saved, Practice hub, videos, news

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Part of ticket 54 (visible read errors). Ticket 54a already built the shared result type and the shared error component (message plus Retry, EN and HI): reuse them, do not rebuild them. Find them with `git log --stat -5 -- web/src/lib web/src/components`, not by searching the repo. DB tests use PGlite. Do not apply migrations. New strings in EN and HI through `web/src/lib/i18n.ts`.

## Definition of done
When a read fails (HTTP error or thrown error) the screen shows the shared error state and never the empty-state text. A read that succeeds with zero rows still shows the empty-state text. The message names no table, column or key. Screens in this ticket: Saved, the Practice hub, videos, and news.

## Test that proves it
For each of the four readers: a 400 gives the error state, a 200 with `[]` gives the empty state. A Retry test for one screen. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- Readers: `web/src/lib/saved/student-page.ts`, `web/src/lib/practice/student-page.ts`, `web/src/lib/videos/page-data.ts`, `web/src/lib/posts/server-posts.ts` (news part only)
- Screens: `web/src/app/(student)/saved/`, `web/src/app/(student)/practice/page.tsx`, `web/src/app/(student)/t/[teacherId]/videos/`, `web/src/app/(student)/t/[teacherId]/news/` (use `ls`, then open only the page files)
- Do NOT touch: `web/src/lib/*/supabase-*-client.ts`, any `teacher-page.ts`, `web/src/app/teacher/**`, `web/src/components/exam-player.tsx`, and Home, Teachers and teacher page counts (ticket 54b)
- Work order: ONE screen per step (reader, screen, test), commit after each step, full checks last.

## Notes / scope guard
Do not change what any query selects. No alerts (ticket 55).

<!-- ralph 2026-11-10T02:33:51.584Z: merge conflict against integration branch -->

<!-- ralph 2026-11-10T15:06:14.324Z: committed + tests pass -->
