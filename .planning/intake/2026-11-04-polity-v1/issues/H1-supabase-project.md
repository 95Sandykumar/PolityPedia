---
id: H1-supabase-project
status: todo
type: human
depends_on: [02-db-harness]
---
# Boss: create the Supabase project and keys

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A Supabase project in Mumbai exists, the migrations are applied, and `web/.env.local` has the keys. The app runs locally against it.

## Vertical slice
- Create the project in region ap-south-1 (Pro org). Turn on Google and email OTP sign-in. Create buckets for PDFs and audio.
- Apply `web/supabase/migrations/*`. Put URL + anon key + service key in `web/.env.local` (never commit). Add the path to `hq/CREDENTIAL-MAP.md`.

## Test that proves it
`npm run dev` in `web/`, sign in with email OTP, a `profiles` row appears (check in the Supabase table view).

## Design constraints
- Secrets: `.env*` is gitignored. Never commit keys.

## Notes / scope guard
Do this any time after issue 02. Ralph does not need it.
