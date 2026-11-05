---
id: 09-teacher-notifications
status: blocked
type: afk
depends_on: [06-portfolio-follow]
---
# Teacher notification posts

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher posts a notice (priority, heading, link). Students see the teacher's posts on the Notifications tile, highest priority and newest first. Home shows the latest posts from followed teachers.

## Vertical slice
- Migration `0009_teacher_posts.sql`: `teacher_posts` (id, teacher_id, priority int, heading, link, created_at). Teacher writes own; signed-in users read.
- Teacher page to add and delete posts. Student `/t/[id]/news` list. Home: latest 5 posts from followed teachers.

## Test that proves it
`npm test`: ordering by priority then date; teacher B cannot delete teacher A's post; Home shows posts only from followed teachers.

## Design constraints
- V17: teacher posts on top; nightly news (v0) is a later slice.

## Notes / scope guard
No images (V2), no push notifications.

<!-- ralph 2026-11-05T17:28:57.258Z: merge conflict against integration branch -->
