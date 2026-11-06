---
id: 38-session-and-alerts-fixes
status: done
type: afk
depends_on: []
---
# Fix: three small gaps found when tickets 33 and 35 were re-checked

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. Supabase is faked in tests. No migration is needed (if one is, name it `0039_session_and_alerts_fixes.sql`). Labels are English and Hindi in `web/src/lib/i18n.ts`. `config.matcher` must stay a literal string.

A reviewer re-checked tickets 33 and 35 and found these. Re-confirm each with a failing test FIRST.

## What is wrong
1. (MEDIUM, ticket 35) `/admin/alerts` hides the webhook alerts. `KINDS` in `src/lib/ledger/supabase-alerts-client.ts` (lines 41-47) and the `ReconcileKind` type in `src/lib/ledger/types.ts` (line 69) omit `currency_mismatch`, `plan_mismatch` and `bad_event`, which `0034` writes and `0035` allows. `readAlertRow` returns null for them, so a refused payment never shows, and the badge (`src/components/admin-open-alerts-count.tsx` line 41) under-counts. Add the three kinds everywhere (type, list, English and Hindi labels, any `Record<ReconcileKind, ...>`), and make an unknown kind show as a generic row instead of being dropped.
2. (MEDIUM, ticket 33) `src/lib/auth/refresh.ts` (near line 55) maps EVERY error, including a Supabase 5xx or a network timeout, to `failed`. `session-middleware.ts` then clears the cookie and redirects, also for `/api/*`. A short outage mid-exam signs the student out and turns an answer-save POST into a 307 to `/sign-in`, so the 401 retry in `src/lib/attempts/browser-attempts-client.ts` is never reached. Fix: clear the cookie only when Supabase answers 400 or 401 for the refresh token (token revoked or invalid). On a 5xx, a timeout or a network error, keep the cookie and let the request continue (the old token may still work, and the next call tries again). For `/api/*` paths answer 401 JSON instead of redirecting.
3. (LOW, ticket 33) `POST /api/auth/sign-out` clears the cookie for a cross-site form POST. Reject the request when the `Origin` header is present and does not match the site's own origin (accept a missing Origin only when `Sec-Fetch-Site` is `same-origin` or absent). Keep the happy path working from the Me tab button.

## Test that proves it
Unit tests: the three alert kinds render in both languages and count in the badge; an unknown kind still renders; a refresh that gets 500, a timeout or a thrown network error keeps the cookie and the request continues; a refresh that gets 400 or 401 clears the cookie, redirects a page request and answers 401 for an `/api` request; the answer-save helper still retries once after a 401; sign-out with a foreign `Origin` is refused with 403 and clears nothing; sign-out with the same origin works. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not sign or encrypt the cookie, and do not touch the database or the exam locks.

<!-- ralph 2026-11-06T00:10:58.190Z: committed + tests pass -->
