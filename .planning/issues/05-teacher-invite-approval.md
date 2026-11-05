---
id: 05-teacher-invite-approval
status: todo
type: afk
depends_on: [03-sign-in]
---
# Teacher invite code, admin approval, and alias privacy

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher with an invite code signs up and waits as pending. An admin approves them. A student can never read the real name of a teacher in alias mode.

## Vertical slice
- Migration `0005_teachers.sql`: `teachers` (user_id PK, identity_mode public/alias, real_name, alias, photo_path, alias_avatar, bio_en, bio_hi, status pending/approved, approved_by, videos_visible bool default true, revenue_share_pct int default 50). `teacher_invites` (code PK, created_by, used_by, used_at).
- View `teachers_public`: in alias mode it returns alias + avatar only; real_name and photo_path never leave the DB for students. Students read the view, not the table.
- Only admin can set `status` and `revenue_share_pct` (V19).
- Pages: teacher signup with invite code; admin list of pending teachers with Approve. Middleware from issue 03 now also checks `status = approved`.

## Test that proves it
`npm test`: (1) privacy: as a student, no query returns `real_name` of an alias teacher; (2) a teacher cannot change own `revenue_share_pct` or `status`; (3) a used invite code cannot be used twice; (4) admin approve sets status approved.

## Design constraints
- v0 privacy rule: alias mode enforced in a DB view + RLS, not only in the UI. Test: student session never reads real_name.
- V19: revenue share is a per-teacher setting, admin-set, default 50.

## Notes / scope guard
No portfolio page yet (issue 06).
