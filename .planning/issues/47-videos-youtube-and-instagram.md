---
id: 47-videos-youtube-and-instagram
status: todo
type: afk
depends_on: [46-teacher-setup-checklist]
---
# Videos: add YouTube videos, Shorts and Instagram reels by URL

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` section 4. DB tests use PGlite; outside services faked (fetch injected). This ticket owns migration **0043** only.

Today: `teacher_videos` (`0008_videos.sql`) stores a YouTube id only; title and thumbnail come from YouTube oEmbed (`src/lib/videos/oembed-video-meta.ts`, no key). Teacher page `/teacher/videos`, API `/api/teacher/videos`, student page `/t/[teacherId]/videos`.

## What to build
1. `0043_videos_multi_platform.sql` (rollback note): add `platform`, `kind`, `url`, `exam_id`, `is_visible`; make `youtube_id` nullable with the CHECKs in design.md. Backfill existing rows as `platform='youtube', kind='video'`.
2. URL parser (pure function): accepts `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/` (kind short), `youtube.com/live/`, `instagram.com/reel/`, `instagram.com/p/` (kind reel). Strips tracking params. Rejects everything else with a clear message.
3. YouTube: keep oEmbed for title + thumb. Instagram: no oEmbed call (needs a Meta app token); the teacher types an optional title; the card shows an Instagram-styled placeholder with the teacher's handle from ticket 46.
4. Teacher page: one "Paste a link" box that detects the platform, tabs or filter chips All / YouTube / Shorts / Instagram, edit title, exam tag, show/hide toggle, reorder (up/down buttons, keyboard accessible), delete (hard delete, no dependents).
5. Student page: same filter chips; YouTube opens youtube.com, Instagram opens instagram.com in a new tab (no embeds).
6. "Coming soon" note on the teacher page: "Auto-import from your channel is coming." (EN + HI).

## Test that proves it
Parser: 15+ URL cases. PGlite: instagram row without url refused, youtube row without id refused, duplicate refused, hidden video not visible to students. Route: fake oEmbed fetch. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No YouTube Data API, no Instagram Graph API, no scraping. Do not apply the migration live.

<!-- ralph 2026-11-09T18:51:51.053Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.205Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.360Z: upstream 54-visible-read-errors blocked -->
