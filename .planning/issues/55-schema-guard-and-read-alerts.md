---
id: 55-schema-guard-and-read-alerts
status: blocked
type: afk
depends_on: [54-visible-read-errors]
---
# Schema guard and read-failure alerts

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Evidence: walk reports in `.planning/intake/2026-11-08-student-journey/walk/`. The app already has an admin alerts mechanism (`/admin/alerts`, used for payments that could not be matched). Reuse it. Do not apply migrations to the live database. DB tests use PGlite.

The launch trap: code that reads a column the live database does not have fails silently. Ticket 54 shows the error to the student. This ticket makes the team hear about it.

## Definition of done
1. `npm run check:schema` compares the columns the app selects (kept in one constants file the readers import) against a database and exits non-zero naming each missing table and column. It runs against PGlite in tests and against a real database when `DATABASE_URL` is set.
2. When a student read fails with 400 or 500, the server writes one admin alert (route, error code, no personal data), at most one per route per 10 minutes.

## Vertical slice
- service: required-columns list + checker + throttled alert writer
- script: `check:schema` in `package.json` scripts
- UI: alert shows in the existing admin alerts page with a clear title

## Test that proves it
PGlite without the 0041 columns: the check fails and names `archived_at`. PGlite with all migrations: the check passes. Alert throttle: two failures in 10 minutes make one alert. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B1 quota: the throttle above is required, no alert storm. No personal data in an alert. The checker never writes to a database.

## Notes / scope guard
Do not run the check against the live database yourself. No Telegram or email sending.

<!-- ralph 2026-11-09T18:55:04.448Z: upstream 54-visible-read-errors blocked -->

<!-- ralph 2026-11-09T21:37:04.252Z: upstream 54-visible-read-errors blocked -->
