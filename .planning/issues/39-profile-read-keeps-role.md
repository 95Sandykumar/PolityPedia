---
id: 39-profile-read-keeps-role
status: todo
type: afk
depends_on: []
---
# Fix: a failed profile read must not downgrade a signed-in user's role

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. Supabase is faked in tests (`src/lib/auth/fake-auth-client.ts`). No migration is needed.

A reviewer found this (finding N4, LOW).

## What is wrong (re-confirm with a failing test FIRST)
`readRole` and `readTeacherStatus` in `src/lib/auth/supabase-auth-client.ts` (about lines 102 and 125) return `student` / `pending` for ANY non-ok response (a 5xx, a 429, a 401). `toSession` runs them on every token response, including `refreshSession`. So when Supabase answers the token refresh but the profile read right after it fails, the NEW session is built with `role: 'student'`. The caller writes that into the cookie, and an admin or an approved teacher is a student for up to 7 days (the cookie lifetime). A thrown network error in those two reads does the same damage in the other direction: the new tokens are lost although Supabase already rotated the refresh token, and the old refresh token is spent.

## Definition of done
1. A refresh keeps the user's previous `role` and `teacherStatus` when the profile read does not answer ok (any non-ok status, or a thrown network error). It never invents a lower role. Pass the previous values in: extend `ServerAuthClient.refreshSession(refreshToken, previous?)` in `src/lib/auth/types.ts` with an optional `{ role, teacherStatus? }`, pass `session.role` and `session.teacherStatus` from `src/lib/auth/refresh.ts`, and update the fake client to match.
2. A refresh whose profile read answers ok with a real row still takes the NEW role (an admin demoted on the server becomes a student at the next refresh).
3. First sign-in (code exchange, email code) has no previous role. There a failed profile read keeps today's fail-closed default (`student`, and `pending` for a teacher).
4. A thrown network error in the profile read during a refresh must not lose the new tokens: the refreshed session is still returned, with the previous role.
5. Nothing is logged: every value in sight is a secret.

## Test that proves it
Unit tests with a fake `fetch` for `createSupabaseAuthClient`: refresh with profile read 500, 401, and a thrown error keeps `admin`; refresh with an ok `student` row for a previous `admin` returns `student`; refresh of a `teacher` with an `approved` status and a failing teacher-status read keeps `approved`; first sign-in with a failing profile read gives `student`. `refresh.ts` tests: the previous role reaches `refreshSession`. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not change the cookie format, the 400/401 sign-out rule, the exam locks, or the database. Do not try to fix the "refresh response lost on the wire" case: Supabase's own reuse window covers it and a server-side session store is a later issue.
