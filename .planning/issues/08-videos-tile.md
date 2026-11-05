---
id: 08-videos-tile
status: todo
type: afk
depends_on: [06-portfolio-follow]
---
# Videos: YouTube links with thumbnail and title, Show / No show

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A teacher pastes YouTube links. Students see each video's thumbnail and title. If the teacher switches Videos to No show, students see a muted 'Coming soon' tile that does not open.

## Vertical slice
- Migration `0008_videos.sql`: `teacher_videos` (id, teacher_id, youtube_id, title, thumb_url, position, created_at). Teacher writes own; students read only when `teachers.videos_visible`.
- URL parser for watch, youtu.be, shorts and embed links. Title from YouTube oEmbed (`https://www.youtube.com/oembed?url=...&format=json`, no key) through a `VideoMeta` interface. Thumbnail `https://i.ytimg.com/vi/<id>/hqdefault.jpg`.
- Teacher page: paste link, list, delete, Show / No show switch. Student page: list with lazy `<img>` with width and height set.

## Test that proves it
`npm test`: parser handles 4 URL forms and rejects a non-YouTube URL; fake oEmbed fills the title; with videos_visible false, the student query returns 0 rows and the tile shows 'Coming soon'.

## Design constraints
- V6: YouTube links only. B4: images lazy with fixed size.

## Notes / scope guard
No YouTube Data API, no captions.
