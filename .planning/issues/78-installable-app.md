---
id: 78-installable-app
status: done
type: afk
depends_on: []
---
# Installable app (no push)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md` (main colour indigo `#4F46E5`). Evidence: walk persona-2 "next morning" table: no manifest, no service worker, no public folder. DB not touched. Strings in EN and HI.

## Definition of done
1. A web app manifest: name PolityPedia, standalone display, start URL `/`, theme and background colours from `web/DESIGN.md`, icons 192 and 512 including a maskable one.
2. A minimal service worker that caches only one static offline page. It never caches signed-in HTML and never caches any `/api` response.
3. The offline page says "You are offline. Open the app again when you have network."
4. Me shows an "Install app" button only when the browser offers install. On iOS, a one line "Add to Home Screen" hint instead.
5. Icons: use an existing brand asset if the repo has one. If not, generate simple icons from the app name and main colour and say in the commit message what was used.

## Vertical slice
- assets: manifest, icons, offline page, service worker
- UI: install button, iOS hint, service worker registration
- i18n: EN and HI

## Test that proves it
Manifest test: required fields, icon sizes. Service worker unit test: the fetch handler passes through everything except the offline page and never caches `/api` or signed-in pages. Component test for the install button. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B1 quota: tiny assets only (B4). Service worker scope is `/` and must not break auth cookies or redirects.

## Notes / scope guard
No push notifications (human ticket H9). No background sync. No offline question bank.

<!-- ralph 2026-11-09T19:36:31.169Z: committed + tests pass -->
