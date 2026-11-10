---
id: 46-teacher-setup-checklist
status: blocked
type: afk
depends_on: [45-keep-money-and-scores, 55-schema-guard-and-read-alerts, 59-start-screen-and-submit-confirm, 61-block-second-order, 62-prepay-card-and-my-purchases]
---
# Teacher setup checklist: photo, profile, exams, channels, first batch

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` sections 3 and 4. DB tests use PGlite. Outside services faked. This ticket owns migration **0042** only. Storage buckets are created by `web/supabase/storage-setup.sql` (not migrations); add the new bucket there.

Today: `teachers.photo_path` exists but nothing writes it. No socials fields. After admin approval the teacher lands on `/teacher/home` with no guidance.

## What to build
1. `0042_teacher_setup.sql` (rollback note at top): `teachers.youtube_channel_url`, `teachers.instagram_handle`, `teachers.setup_done_at` with the CHECKs in design.md section 4. Extend `teachers_public` view with the two channel fields. Existing `teachers_block_admin_fields` trigger must still block status/share edits.
2. `storage-setup.sql`: public bucket `avatars`, 2 MB limit, image/jpeg, image/png, image/webp; owner-only insert/update/delete on path `<auth.uid()>/...`.
3. `POST /api/teacher/photo`: multipart upload, server resizes to 256x256 webp (use `sharp` only if already a dependency; otherwise accept the client-cropped webp from a canvas and verify size/type server side; do NOT edit package.json), writes `photo_path`. `DELETE` clears it.
4. Channels form: YouTube channel URL (accept `youtube.com/@handle`, `youtube.com/channel/UC...`; normalise to https), Instagram handle (accept `@name` or full profile URL, store lowercase handle). Clear error text for bad input.
5. `/teacher/setup` page: 5 steps (Photo, About you, Exams + next date, Channels, First batch + share link), each skippable, progress "3 of 5". Reuse existing profile, exams and batch APIs; do not duplicate them. Home shows a "Finish setup" card until all 5 are done or the teacher taps "Done for now" (sets `setup_done_at`). First approved sign-in redirects to `/teacher/setup` once.
6. Student teacher page (`/t/[teacherId]`) shows the photo and YouTube / Instagram buttons (plain `<a>` with `rel="noopener"`).
7. All new strings in EN and HI through the existing i18n file.

## Test that proves it
Unit: URL/handle normalisers (10+ good and bad cases). PGlite: teacher can set own channels, cannot set another teacher's, bad URL refused by CHECK, `teachers_public` exposes channels only for approved teachers. Route test: photo over 2 MB or wrong type refused. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No auto-import from YouTube or Instagram (Upcoming). Do not apply migrations or storage SQL to the live database.

<!-- ralph 2026-11-09T18:51:51.051Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.201Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.353Z: upstream 54-visible-read-errors blocked -->
