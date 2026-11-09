---
id: 54-visible-read-errors
status: blocked
type: afk
depends_on: []
---
# Visible read errors instead of false "nothing here yet"

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: `.planning/intake/2026-11-08-student-journey/walk/persona-1-new-aspirant.md` gap 2, persona-2 gap 1, persona-3 gap 1. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. New strings in EN and HI through the existing i18n file.

Today the student readers swallow every failure with `.catch(() => [])` or `if (!res.ok) return []`. A missing database column showed "No mock tests yet. Your teacher adds them soon." and "0" counts while the content existed.

## Definition of done
When any student read fails (HTTP error or thrown error), the screen shows an error state with a plain message and a Retry button. It never shows the empty-state text. A read that succeeds with zero rows still shows the empty-state text. Covered screens: mock list, papers list, teacher page tile counts, Home (followed teachers and notices), Teachers list, Saved, Practice hub, videos, news.

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

<!-- ralph 2026-11-09T18:55:04.445Z: no new commit -- slice unfinished -->
