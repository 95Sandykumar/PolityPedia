---
id: 24-revision-teacher-edit
status: todo
type: afk
depends_on: [22-revision-api]
---
# Teacher edits AI explanations of their own questions

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher opens an AI explanation of one of their questions, edits the text, and saves. Students then see the edited version.

## Vertical slice
- RLS: only the question's teacher can update `ai_explanations` rows of that question; sets `edited_by_teacher = true`.
- Teacher page: list of explanations for their questions, edit form.

## Test that proves it
`npm test`: teacher A edits own question's explanation; teacher B cannot; students read the edited body.

## Design constraints
- F-F4: the teacher can edit it. F7: human gate on AI text.

## Notes / scope guard
No version history.

<!-- ralph 2026-11-05T18:52:21.333Z: upstream 22-revision-api blocked -->
