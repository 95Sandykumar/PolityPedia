---
id: 80-fix-double-tap-order-race
status: done
type: afk
depends_on: []
---
# Fix: two quick taps can both create a pending order (ticket 61 review finding)

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. DB tests use PGlite. Outside services faked. Do not apply migrations to the live database. Strings in EN and HI through the existing i18n file. Review of ticket 61 found that the check-then-insert in migration 0049 has no lock. Two truly concurrent calls both read "no pending row" and both insert.

## Definition of done
Two concurrent order requests by the same buyer for the same set produce exactly one pending order. The second gets the same "pending" refusal as today. Behaviour for all other cases is unchanged.

## Vertical slice
- db: a new migration **0055** replaces the function from 0049. It takes `pg_advisory_xact_lock(hashtextextended(buyer::text || for_set::text, 0))` just before the pending-order select. Do not edit 0049.

## Test that proves it
A test that fires two calls at the same time (two connections or `Promise.all`), not one after the other, and asserts exactly one pending row. Existing 61 tests still pass. `npm test`, `npm run typecheck`, `npm run build` pass.

## Start here (file map, read ONLY these)
- `web/supabase/migrations/0049_block_second_order.sql` (copy the function body into 0055, add the lock)
- `web/test/block-second-order.test.ts`
- Do not grep the whole repo. Do not `cat` whole files.

## Notes / scope guard
Migration only plus its test. No UI change. A pending row with a NULL order id is a known, accepted case.

<!-- ralph 2026-11-09T21:59:57.905Z: committed + tests pass -->
