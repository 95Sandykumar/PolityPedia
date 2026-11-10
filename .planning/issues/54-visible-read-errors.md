---
id: 54-visible-read-errors
status: todo
type: afk
depends_on: [54b-read-errors-home-teachers, 54c-read-errors-saved-practice-media]
---
# Visible read errors, part 3: close-out audit

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: `.planning/intake/2026-11-08-student-journey/walk/persona-1-new-aspirant.md` gap 2, persona-2 gap 1, persona-3 gap 1. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. New strings in EN and HI through the existing i18n file.

Part 1 (ticket 54a) built the shared result type and error component and covered the mock list and papers list. This ticket applies them to the remaining screens; reuse them, do not rebuild them. Today the student readers swallow every failure with `.catch(() => [])` or `if (!res.ok) return []`. A missing database column showed "No mock tests yet. Your teacher adds them soon." and "0" counts while the content existed.

## Definition of done
Parts 54a, 54b and 54c covered the screens. This ticket is the close-out check only. Find any student read still using `.catch(() => [])`, `.catch(() => null)`, `!res.ok) return []` or `!res.ok) return null` under the student side files listed below. Fix each leftover with the shared type and error component. If there are none, add a short test or note proving the grep is clean and finish.

## Test that proves it
A grep-based test (or documented command) that fails if a student reader swallows an error again. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these)
- Student readers: `web/src/lib/{attempts,exam,follows,practice,saved,set-access}/student-page.ts`, `web/src/lib/videos/page-data.ts`, `web/src/lib/posts/server-posts.ts`, `web/src/app/(student)/_data/student-ui-data.ts`
- Use `grep -n` on those files only. Do not open teacher-side or write-side files. Do not `cat` whole files.

## Notes / scope guard
Do not change what any query selects. No alerts (ticket 55). Do not touch teacher screens.
