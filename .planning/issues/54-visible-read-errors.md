---
id: 54-visible-read-errors
status: blocked
type: afk
depends_on: [54a-read-error-core]
---
# Visible read errors, part 2: the remaining student screens

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: `.planning/intake/2026-11-08-student-journey/walk/persona-1-new-aspirant.md` gap 2, persona-2 gap 1, persona-3 gap 1. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. New strings in EN and HI through the existing i18n file.

Part 1 (ticket 54a) built the shared result type and error component and covered the mock list and papers list. This ticket applies them to the remaining screens; reuse them, do not rebuild them. Today the student readers swallow every failure with `.catch(() => [])` or `if (!res.ok) return []`. A missing database column showed "No mock tests yet. Your teacher adds them soon." and "0" counts while the content existed.

## Definition of done
When any student read fails (HTTP error or thrown error), the screen shows an error state with a plain message and a Retry button. It never shows the empty-state text. A read that succeeds with zero rows still shows the empty-state text. Covered screens in this ticket (mock list and papers list are done in 54a): teacher page tile counts, Home (followed teachers and notices), Teachers list, Saved, Practice hub, videos, news.

## Vertical slice
- service: each student reader returns a result that separates "ok but empty" from "failed" (no more swallowed errors)
- UI: one shared error component (message + Retry) used by every covered screen
- i18n: EN and HI strings

## Test that proves it
For each covered reader: a 400 response gives the error state, a 200 with `[]` gives the empty state. One test reproduces the original bug: a response saying the column `archived_at` does not exist must give the error state, not "No mock tests yet". Component test for Retry. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B3: links keep the existing prefetch wrapper pattern. The error message names no table, column, or key. Alerts are ticket 55, not this ticket.

## Notes / scope guard
Do not change what any query selects. Do not add alert sending. Do not touch teacher screens.

## Start here (file map, read ONLY these, use `sed -n` ranges or `grep -n`, never `cat` a whole file)
- Core from 54a: the shared result type file and the shared error component (find them with `git log --stat -3 -- web/src/lib` , do not search the repo)
- Readers: `web/src/lib/follows/student-page.ts`, `web/src/lib/saved/student-page.ts`, `web/src/lib/practice/student-page.ts`, `web/src/lib/videos/page-data.ts`, `web/src/lib/posts/server-posts.ts`
- Screens: `web/src/app/(student)/page.tsx`, `web/src/app/(student)/practice/page.tsx`, `web/src/app/(student)/saved/`, `web/src/app/(student)/teachers/`, `web/src/app/(student)/t/[teacherId]/` (use `ls` then open only the page files)
- Strings: `web/src/lib/i18n.ts` (add keys only)
- Do NOT touch: `web/src/lib/*/supabase-*-client.ts`, `web/src/lib/*/teacher-page.ts`, `web/src/app/teacher/**`, `web/src/components/exam-player.tsx`
- Work order: do ONE screen per step (reader, screen, test), commit after each step, run the full checks last.

<!-- ralph 2026-11-10T00:05:26.296Z: no new commit -- slice unfinished -->
