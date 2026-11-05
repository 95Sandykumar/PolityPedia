---
id: 20-batch-reports
status: blocked
type: afk
depends_on: [19-batches, 18-exam-mode]
---
# Batch score reports for teachers

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher opens a batch and sees a score table per test and per student, for their own tests only.

## Vertical slice
- RLS or a security-definer function: a teacher reads `attempts` of their batch members on their own tests only.
- Batch page table: rows students, columns tests, cells score (tabular numbers).

## Test that proves it
`npm test`: teacher A sees member scores on own tests; teacher A sees nothing on teacher B's tests; teacher B sees nothing of batch A.

## Design constraints
- F-B4: batch scores on own tests only.

## Notes / scope guard
No export, no charts.

<!-- ralph 2026-11-05T18:44:34.418Z: upstream 15-mock-sets-authoring blocked -->
