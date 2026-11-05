---
id: H2-vercel-deploy
status: todo
type: human
depends_on: [03-sign-in]
---
# Boss: Vercel project (own account, bom1)

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
The app is on its own Vercel project with root `web/`, region bom1, and env vars set. Branch builds are off.

## Vertical slice
- New Vercel project, root directory `web/`, functions region `bom1`. `web/vercel.json` with `git.deploymentEnabled` set so only `main` builds.
- Before the first sale: Vercel Pro (B9).

## Test that proves it
Open the preview URL, sign-in works, `curl -I` on a static file shows a finite max-age (B2).

## Design constraints
- B5 one repo one project. B9 Pro before first sale.

## Notes / scope guard
Not needed for Ralph.
