---
id: 48-news-text-and-link-preview
status: blocked
type: afk
depends_on: [H6-teacher-v11-picks, 47-videos-youtube-and-instagram]
---
# News v2: written posts, link preview cards, pin, exam tag

Decision D2 (from H6): A, confirmed by Boss 2026-11-06. A = written text + link preview; voice note is Upcoming.

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` sections 4 and 7 (C: SSRF rules). DB tests use PGlite; fetch is injected and faked in tests. This ticket owns migration **0044** only.

Today: `teacher_posts` (`0009_teacher_posts.sql`) = heading + optional link + priority 0-2. Teacher page `/teacher/posts`, API `/api/teacher/posts`, student page `/t/[teacherId]/news`, notifications from ticket 09.

## What to build
1. `0044_news_v2.sql` (rollback note): `body` (<=2000 chars), `exam_id`, `pinned_at`, `link_title`, `link_image`, `link_site`, `edited_at`. Trigger: max 3 pinned per teacher. Heading stays required.
2. Link preview fetcher (server only, `src/lib/news/link-preview.ts`): https only; resolve DNS and refuse private, loopback, link-local and metadata IPs (also after each redirect, max 3 redirects); 3 s timeout; read at most 512 KB; parse `og:title`, `og:image` (https only), `og:site_name`, fallback `<title>`. Runs once when a post is saved or its link changes; result stored on the row. Students never trigger a fetch. Failure = post saves without a card.
3. Composer: heading, body (plain text, line breaks kept, links auto-detected and rendered safely, no HTML), optional link with live "Preview" button, exam tag, pin toggle, priority. Edit shows "edited". Delete is hard delete.
4. Student news page: pinned first, then newest; card with image, title, site; filter by exam.
5. "Voice note: coming soon" hint in the composer (EN + HI).

## Test that proves it
Preview fetcher: private IP, `http://`, redirect to 169.254.169.254, oversize body, timeout, missing og tags (all with fake fetch/DNS). PGlite: 4th pin refused, body over 2000 refused, other teacher cannot edit. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No audio upload. No rich text editor dependency. Do not edit package.json. Do not apply the migration live.

<!-- ralph 2026-11-09T18:51:51.055Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.208Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.366Z: upstream 54-visible-read-errors blocked -->

<!-- ralph 2026-11-10T02:33:51.603Z: upstream 54c-read-errors-saved-practice-media blocked -->

<!-- ralph 2026-11-10T15:59:02.630Z: upstream 59-start-screen-and-submit-confirm blocked -->
