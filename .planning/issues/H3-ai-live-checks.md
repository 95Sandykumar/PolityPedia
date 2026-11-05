---
id: H3-ai-live-checks
status: todo
type: human
depends_on: [12-pdf-split-worker, 22-revision-api]
---
# Boss: live AI checks (split accuracy, cost, web search version)

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
Real numbers replace the estimates: split accuracy on one real paper (AS2), cost of one new explanation (AS3), and which web search version Haiku 5.5 accepts (X7).

## Vertical slice
- Run the split on 1 real paper from the founding teacher; count right questions (target 80%).
- Make 1 real explanation; read tokens_in, tokens_out, searches from the row; compare with $0.022.
- Set a monthly spend alert in the Anthropic console.

## Test that proves it
Numbers written into `notes.md`.

## Design constraints
- F5 proof of done. AS2, AS3, X7.

## Notes / scope guard
Needs the Anthropic key in `web/.env.local`.
