---
id: 03-sign-in
status: todo
type: afk
depends_on: [02-db-harness]
---
# Sign in with Google or email OTP, and role guards

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A visitor can sign in with Google or with an email one-time code. A student who opens a `/teacher` or `/admin` page is sent back to Home.

## Vertical slice
- Supabase client wrappers (browser + server) behind an `AuthClient` interface; env read lazily.
- Sign-in page: Google button + email field + 6-digit code step. Labels in en/hi.
- Route `/auth/callback`. On first sign-in a `profiles` row is created (role student).
- Middleware: `/teacher/*` needs role teacher (approved status comes in issue 05; until then role teacher is enough), `/admin/*` needs role admin. Matcher excludes `_next/static`, `_next/image` and asset files.

## Test that proves it
`npm test` with a fake AuthClient: OTP submit calls send-code with the email; code step calls verify; middleware redirects a student from `/teacher/home` to `/`; matcher does not match `/_next/static/x.js`.

## Design constraints
- B7: middleware matcher excludes static assets.
- Security: never log the email code or tokens.

## Notes / scope guard
No teacher invite flow (issue 05). No onboarding (issue 04).
