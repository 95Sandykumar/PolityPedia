---
id: 63-public-landing
status: todo
type: afk
depends_on: []
---
# Public landing and a shareable teacher link

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 3 and step 1, 7. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today a logged-out visitor opening `/` sees "Teachers are not set up yet" with no pitch and no Sign in button. A shared `/t/<teacherId>` link shows the same dead screen.

## Definition of done
1. Logged-out `/` shows a landing: one-line pitch (UGC NET, CUET PG), a "Try a free test" button, a "Sign in" button, and how it works in three short lines.
2. Logged-out `/t/<teacherId>` shows the teacher profile from the public fields with a "Sign in to follow" button.
3. Signed-in users see no change.

## Vertical slice
- UI: landing component, public teacher view, buttons to `/sign-in`
- service: public teacher read

## Test that proves it
Render tests logged-out and signed-in for both routes. If anonymous callers cannot read the public teacher view today, show a generic sign-in prompt instead of the profile, say so in the commit message, and do NOT add a migration. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
C (public endpoint): show only public fields; never an alias teacher's real name. No signed-in data may be cached or shown to anonymous callers. B3 prefetch wrapper.

## Notes / scope guard
No marketing site, no pricing page. "Try a free test" can lead to sign-in for now; the free test card is ticket 68.
