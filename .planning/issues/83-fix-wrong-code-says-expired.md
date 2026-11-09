---
id: 83-fix-wrong-code-says-expired
status: todo
type: afk
depends_on: []
---
# Fix: a wrong sign-in code may say "expired" (ticket 64 review finding)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. Strings in EN and HI through the existing i18n file. Review of ticket 64 suspects the auth service returns the same "expired" code for a wrong code and an expired one. This is unverified: the reviewer could not test a real wrong code. Making the message neutral is correct either way.

## Definition of done
When a code fails, the message says the code is wrong or has expired and tells the student to check it or tap Resend. It never claims "expired" alone. Remove the unused `auth.resendIn` string (EN and HI).

## Vertical slice
- service: `sign-in-errors.ts` maps the failure to one neutral reason
- i18n: neutral EN and HI wording, remove `auth.resendIn`

## Test that proves it
A test with the failure shapes the auth service can send (403 with and without `otp_expired`) all give the neutral message. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these)
- `web/src/lib/auth/sign-in-errors.ts`
- `web/src/lib/auth/__tests__/sign-in-errors.test.ts`
- `web/src/lib/i18n.ts`
- Do not grep the whole repo. Do not `cat` whole files.

## Notes / scope guard
Do not change the resend cooldown or the rate-limit messages.
