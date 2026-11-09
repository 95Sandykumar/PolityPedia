---
id: 82-fix-install-button-missed-event
status: done
type: afk
depends_on: []
---
# Fix: the Install button never shows if the student reaches Me by tapping (ticket 78 review finding)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. Strings in EN and HI through the existing i18n file. Review of ticket 78 found `install-app.tsx` adds its `beforeinstallprompt` listener only when it mounts on the Me page. The browser fires that event once, soon after page load. A student who opens Home and then taps Me has already missed it, so the button never appears.

## Definition of done
The Install button appears on Me when the browser allows install, whether the student loads Me directly or taps to it from another page.

## Vertical slice
- UI: capture the event once in an always-mounted client component (the service worker register in the root layout is a good place), keep it on a module variable, and let `InstallApp` read it and also subscribe for a later event.

## Test that proves it
A component test where the event is dispatched BEFORE `InstallApp` mounts, then `InstallApp` mounts and shows the button. The old after-mount case still works. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these)
- `web/src/components/install-app.tsx`
- `web/src/components/service-worker-register.tsx`
- The root layout that mounts the register component (find it with `grep -rn "ServiceWorkerRegister" web/src --include=*.tsx`)
- Do not grep the whole repo. Do not `cat` whole files.

## Notes / scope guard
Do not change the offline page or the service worker file. Do not add the iPad hint.

<!-- ralph 2026-11-09T22:17:14.135Z: committed + tests pass -->
