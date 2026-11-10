---
id: 84-tighten-install-event-test
status: done
type: afk
depends_on: []
---
# Tighten the test for the Install button event (ticket 82 review finding)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Review of ticket 82 found its new test "event fires before InstallApp mounts" still passes if the real fix is deleted. Earlier tests in the same file already mounted `InstallApp`, whose effect also calls `captureInstallPrompt()`, so the module listener was already installed.

## Definition of done
The test fails if the always-mounted `ServiceWorkerRegister` stops capturing the event, and passes with the fix in place.

## Test that proves it
Use `vi.resetModules()` plus a dynamic import for this one test, so nothing else has installed the listener. Mount only `ServiceWorkerRegister`, dispatch `beforeinstallprompt`, then mount `InstallApp` and expect the button. Then prove it bites: temporarily remove the capture call from `ServiceWorkerRegister`, see the test fail, restore it. `npm test`, `npm run typecheck` pass.

## Start here (file map, read ONLY these)
- `web/src/components/__tests__/install-app.test.tsx`
- `web/src/lib/install-prompt.ts`
- `web/src/components/service-worker-register.tsx`
- `web/src/components/install-app.tsx`
- Do not grep the whole repo.

## Notes / scope guard
Tests only. Do not change production code.

<!-- ralph 2026-11-09T23:45:08.912Z: committed + tests pass -->
