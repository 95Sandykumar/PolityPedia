---
id: 06-portfolio-follow
status: done
type: afk
depends_on: [04-exams-onboarding, 05-teacher-invite-approval]
---
# Teachers tab, teacher portfolio with 4 tiles, and Follow

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student opens the Teachers tab, sees approved teachers for their exams, opens one, sees the portfolio (avatar, name, 4 tiles: Videos, Past papers, Mock tests, Notifications) and taps Follow. The button then reads 'Following'.

## Vertical slice
- Migration `0006_follows.sql`: `follows` (user_id, teacher_id, created_at) PK both, RLS own rows.
- Teachers tab list from `teachers_public`. Portfolio page `/t/[teacherId]`: header, 2 x 2 tile grid (96 px tall, icon + 1 word), full-width Follow button (primary, becomes outline 'Following' with a check icon). Tiles link to `/t/[id]/videos`, `/papers`, `/mocks`, `/news` placeholder pages.
- Home tab: list of followed teachers.

## Test that proves it
`npm test`: follow then unfollow works for own rows; a student cannot insert a follow for another user; portfolio renders 4 tiles and the Follow button; an alias teacher shows the alias.

## Design constraints
- DESIGN.md section 8 Teacher portfolio. Follow is free (renamed from Subscribe).

## Notes / scope guard
No videos, dates or posts content (issues 07 to 09).

<!-- ralph 2026-11-05T17:12:05.814Z: committed + tests pass -->
