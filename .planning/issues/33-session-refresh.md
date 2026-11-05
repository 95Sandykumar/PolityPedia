---
id: 33-session-refresh
status: todo
type: afk
depends_on: []
---
# Security and reliability fix: renew the sign-in token, and add sign out

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md`. Run the tools from inside `web/`. Every outside service (Supabase Auth) is behind a small interface and faked in tests. Labels exist in English and Hindi in `web/src/lib/i18n.ts`. No migration is needed for this ticket (if one is, name it `0033_session_refresh.sql`).

This is a RELIABILITY and SECURITY FIX from the 2026-11-05 code review. Ticket 03 built sign-in.

## What is wrong (re-confirm by reading)
- `src/lib/auth/session.ts` keeps a 7 day httpOnly cookie. `src/lib/auth/supabase-auth-client.ts:111` stores `refreshToken`, and nothing ever uses it (a grep for `refreshToken` outside tests finds only the three auth files). Supabase access tokens last about 1 hour by default (a dashboard setting, assume 1 hour).
- After the access token expires, every call made with the student's token fails with 401, while the middleware still treats the user as signed in. A mock test can run up to 360 minutes (`mock_tests.duration_min`). In a 3 hour exam, saving answers fails after minute 60, and `score_attempt` fails too, so `submitted_at` never gets set.
- There is no sign out route and no sign out button. The cookie is only ever set, never cleared. On a shared phone the session stays for 7 days.

## Definition of done
1. The session cookie records when the access token expires. When the token is within 2 minutes of expiry (or expired), the middleware (or a small route used by it) calls Supabase Auth with the refresh token, writes the new tokens back into the same httpOnly cookie, and the request continues signed in.
2. If the refresh fails (token revoked or invalid), the cookie is cleared and the user is sent to the sign-in page.
3. During an exam, the answer-save calls recover: if one call returns 401, the client asks for a refresh once and retries, so the exam is not lost.
4. `POST /api/auth/sign-out` calls Supabase sign out for the session, clears the cookie, and returns to `/sign-in`. A Sign out button is on the Me tab (bilingual label, 48px touch target, DESIGN.md styling).
5. Cookie flags stay httpOnly, SameSite=Lax, Secure in production.

## Vertical slice
- Session helpers and a `refreshSession` method on the auth client interface plus its fake.
- Middleware change. Remember: `config.matcher` must stay a literal string (Next.js rule).
- Sign out route and Me tab button.

## Test that proves it
Unit tests with the fake auth client: a token near expiry is refreshed and the cookie is rewritten with new values; a failed refresh clears the cookie and redirects to sign-in; a fresh token is not refreshed (no extra call); sign out clears the cookie and calls the client once; the answer-save helper retries once after a 401 and then succeeds; it does not loop forever on repeated 401. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not sign or encrypt the cookie contents in this ticket (a separate medium finding). Do not touch the database. Only refresh, retry, and sign out.
