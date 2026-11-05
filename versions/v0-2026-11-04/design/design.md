# PolityPedia V1 design (draft 3, 2026-11-04)

Status: DRAFT 3. Built with the `system-design` skill. Not yet run by Reality Checker.
Change from draft 2: two-sided platform (teachers + students), teacher profiles (3 YouTube + 2 Instagram), identity mode, teacher communities (Discord/Telegram style, teacher controls who can post), 6 tabs, news once nightly, YouTube transcripts (Boss accepted the risk), separate Vercel account.

## 0. Boss decisions (locked)
| Decision | Pick |
|---|---|
| V1 | Free hub + AI tutor + newsletter |
| Exams | UGC NET, CUET PG, PGT, TGT |
| Language | Hindi + English |
| Brand | PolityPedia, teacher can stay anonymous |
| Vercel | Separate free account (own 1M cap) |
| Transcripts | Pull from YouTube. Boss accepts YouTube ToS + Adda247 contract risk (2026-11-04). |
| Teachers | Own bottom tab (6 tabs) |
| Signups | Supabase + nightly read-only Google Sheet copy |
| News | Once a day, at night |
| Platform | Two-sided: teachers build their own audience here |
| Teachers | Invite only. Admin makes an invite link; teachers forward it; every signup still needs admin approval. |
| Instagram | Link buttons only in V1, live professional feed in V2 |
| Load | 100 DAU at start |
| Domain | Free `politypedia.vercel.app`. Newsletter = site page + Telegram post. Emails collected; email sending starts when a domain is bought. |
| Notes | 10 PDFs. P4 extracts the text layer first, vision OCR only if a page has none. |
| Pricing | Free for early users at launch. Then Pro at Rs 500/month. Free tier: videos, teachers, news, community, daily quiz, 5 AI questions/day. Pro: AI tutor (fair use 100/day), full mocks, notes PDFs, score vs cut-off analysis. |

### Pricing impact (added 2026-11-04)
- `plans` (id free/early/pro, price_inr, limits jsonb) + `entitlements` (user_id, plan_id, source early/razorpay/admin, valid_until). One SQL function `can_use(user, feature)` used by RLS and API routes. Switching Pro on = data change, not code change.
- Payments (V2): Razorpay Subscriptions, UPI autopay. Money checks A1-A6 become mandatory: webhook signature first, event id de-dupe, forward-only state, daily Razorpay vs DB reconcile job (P8).
- B9: paid = commercial. Vercel Pro required before the first paid student.
- Contract: paid product raises the Adda247 contract risk. Check before charging.
- Open: what early users get after the free period; when Pro starts; teacher revenue share.

## 1. Blockers
1. Separate Vercel account: Boss creates it with a new email. Whether Vercel terms allow a second Hobby account per person: unverified. Check before launch.
2. Teacher video links: DONE (agent, 2026-11-04). See research/2026-11-04-teacher-videos.md. Rate is ~1 Pol Sci long video a week, not 1 a day. Size P3 + RAG for 4-6 classes a month.
3. Notes answer "10" is unclear: 10 PDFs, pages or units? Typed or handwritten? Language?
4. Domain (checked 2026-11-04): politypedia.vercel.app returns `X-Vercel-Error: DEPLOYMENT_NOT_FOUND` (not claimed). politypedia.app available, $9.99 first year, $15 renewal (Vercel registrar). politypedia.com and .org taken. politypedia.in: Vercel registrar cannot check .in (404/400), unverified. Resend cannot send without a verified domain (resend-node issue #454), so on the free address the newsletter = web page + Telegram post, emails collected for later.

## 2. Requirements
Functional
- F1 Sign up: Google or email OTP. Role = student (default) or teacher (invite only, admin approves).
- F2 Videos: Political Science videos from @ugcnetadda247 + teacher-linked channels, thumbnails, filters YouTube lacks.
- F3 Teachers tab: list of teachers. Teacher page = profile, latest videos from up to 3 YouTube channels, 2 Instagram links (professional + personal), Follow button, community.
- F4 Teacher identity mode: Public (name, photo, all links) or Alias (alias + avatar, real name, photo and links hidden). Switching keeps all followers.
- F5 Community: each teacher owns groups. Post modes: Broadcast (only teacher posts, default), Allow-list (teacher picks students who can post), Open. Teacher can delete, mute, remove. Students can report. No student-to-student or teacher-student DMs in V1.
- F6 News tab: built once a night, max 10 items, 2 lines in our own words (EN + HI), unit + exam tags, source link.
- F7 Class library + RAG: teacher notes, class transcripts, PYQs. All knowledge tagged by teacher_id, so each teacher's tutor can later answer from only their content.
- F8 AI tutor: answers only from RAG, cites source, "not in notes" otherwise. 20 questions per student per day.
- F9 PYQ bank, daily quiz, mocks.
- F10 Weekly newsletter, teacher-approved.
- F11 Teacher dashboard: edit profile + links, identity mode, groups + post permissions, approve newsletter, fix video tags, signup count.

Non-functional
- India, cheap Android, 4G. Supabase `ap-south-1`, Vercel functions `bom1`.
- Minimum text. 6 tabs: Home, Videos, Teachers, News, Practice, Ask.
- Assumption: 500 DAU in 3 months (unverified).

Limits table (B1)
| Limit | Cap | Current use (proof) | This design adds |
|---|---|---|---|
| Vercel edge requests | 1M / rolling 30 days, own account | 0 (new account). Old team: 446,699 / 30 days (Vercel CLI `/v2/usage`, 2026-11-04) | ~3,000 per DAU per 30 days (20 views/day x 5 req) |
| Vercel image optimization | Hobby quota | 0 | 0: thumbnails are plain `<img>` from YouTube |
| YouTube Data API | 10,000 units/day | 0 | ~24/day: discovery via channel RSS (0 units), `videos.list` durations (1 unit per 50) |
| YouTube channel RSS | not metered | 0 | Adda hourly + teacher channels every 2 h |
| Supabase Realtime | Pro: 500 peak concurrent connections, $10 per 1,000 over (supabase.com/docs, 2026-11-04) | 0 | 1 connection only while a student has a group screen open |
| Supabase | Pro org, compute per project | 4 projects, all us-east-1 (Supabase MCP, 2026-11-04) | 1 new project in Mumbai |
| Instagram | API supports professional accounts only. Basic Display API shut down 4 Dec 2024 (Meta dev blog). | n/a | V1: links only. V2: professional feed via Instagram Login + Meta app review |
| Claude API | per token | n/a | tutor + tagging + news (Haiku 5.5), newsletter (Sonnet 5) |

Feeds tested 2026-11-04 (curl): PIB, MEA, The Hindu national + international, Indian Express Explained, YouTube channel RSS = HTTP 200. PRS rss.xml = 404.

## 3. Design
Components
- Web app: Next.js on its own Vercel account. Student UI + teacher dashboard behind role checks.
- Supabase (Mumbai): Auth, Postgres (single source of truth), RLS on every table, pgvector + full-text, Storage, Realtime for groups.
- Chat traffic and chat history go browser -> Supabase directly. They never touch Vercel's request cap.
- Pipelines = PM2 `cron_restart` jobs in ClaudeClaw on Boss's laptop, each with `CLAUDECODE: ''`. Laptop time is CST.
  - P1 `polity-yt-sync` hourly: RSS of Adda channel (`UCeOoUjlLiP5qKBozcdIjnGA`, RSS HTTP 200, 15 entries = ~10 h of uploads) + every active teacher channel (max 3 per teacher) -> upsert `videos`. Daily catch-up: `playlistItems.list` on the uploads playlist, last 100 (2 units), covers laptop downtime. Teacher filter: "Political Science" (any case) AND ("Puneet Sir" OR "Puneet Mishra") in title OR description. Name alone is wrong: a different "Puneet Sir" teaches UGC NET Hindi on the same channel. Name-less shorts go to a "teacher confirms" queue.
  - P2 `polity-tagger` after P1: Haiku tags unit, topic, exam, type, language. Titles wrapped as untrusted.
  - P3 `polity-transcribe` nightly 2 AM CST: only videos linked to an onboarded teacher. Step 1: YouTube auto-captions (Hindi/English). Step 2 if none: audio -> speech to text. Runs on the laptop's home internet connection (YouTube blocks most cloud servers). Cap 5 videos/night. First block or 429 = stop until the next night. Output -> `classes` -> chunks + embeddings.
  - P4 `polity-notes-ingest` on upload.
  - P5 `polity-news-sync` once a night, 2:00 AM IST (cron `30 14 * * *` CST): 5 feeds -> dedupe url_hash -> Haiku score + tags + 2-line EN/HI summary -> keep top 10.
  - P6 `polity-newsletter`: Saturday draft from the week's news + new classes + PYQ -> teacher approves -> Sunday 7 AM IST send -> `send_key` written first.
  - P7 `polity-sheet-mirror` nightly: signups -> read-only Google Sheet.

Data model (owner = Supabase, RLS on all)
- `taxonomy` (unit_no, topic_id, name_en, name_hi, exams[])
- `profiles` (user_id, role student/teacher/admin, name, exams[], lang, state, attempt_year, consent_at)
- `teachers` (user_id PK, identity_mode public/alias, real_name, alias, photo_path, alias_avatar, bio_en, bio_hi, subjects[], status pending/approved, approved_by)
- `teacher_links` (id, teacher_id, platform youtube/instagram, kind main/second/third or professional/personal, url, channel_id, position). Constraint: max 3 youtube, max 2 instagram per teacher (trigger).
- `channels` (channel_id PK, teacher_id null, name, kind adda/teacher, active, poll_every_min)
- `follows` (user_id, teacher_id, created_at) PK both
- `invites` (code PK, created_by, max_uses, used_count, expires_at). `teachers.invited_by` records who forwarded it.
- `groups` (id, teacher_id, name, post_mode broadcast/allowlist/open, created_at)
- `group_members` (group_id, user_id, can_post bool, muted_until, joined_at)
- `messages` (id, group_id, user_id, body, attachment_path, created_at, deleted_at)
- `reports` (id, message_id, reporter_id, reason, status)
- `videos` (yt_id PK, channel_id FK, title, published_at, duration_s, thumb_url, kind, unit_nos[], topic_ids[], exams[], content_type, lang, tag_status)
- `classes` (id, teacher_id, yt_id, series, class_no, unit_no, topic_ids[], exams[], thinkers[], lang, transcript_source captions/stt/upload, transcript_status, teacher_checked)
- `documents`, `chunks` (+ teacher_id on both)
- `news_sources`, `news_items` (url_hash UNIQUE)
- `subscribers`, `pyqs`, `attempts`, `tutor_logs`, `newsletter_issues` (week PK, send_key), `job_runs`

Identity rule: when `identity_mode = alias`, the public API returns alias + avatar only. `real_name`, `photo_path` and `teacher_links` are never sent to students. Enforced in a Postgres view + RLS, not only in the UI.

Post rule (RLS on `messages` insert): user is the group's teacher, OR (member AND not muted AND (post_mode = open OR (post_mode = allowlist AND can_post))).

Abuse caps: 1 message per 5 s per student, 2,000 characters max, images/PDF 5 MB max, teacher only for attachments in V1.

## 4. Checks
| ID | Status | Proof / plan |
|---|---|---|
| A1-A6 | N/A now, MANDATORY at Pro launch | Razorpay webhook signature, event de-dupe, forward-only, reconcile job. |
| B1 | PASS | Old team usage pulled (446,699 / 30 days). New account starts at 0. Realtime + Instagram limits read from vendor docs. |
| B2 | Plan | Finite max-age on `public/`, `curl -I` after deploy. |
| B3 | Plan | `prefetch={false}` or hover-prefetch. Measure requests per view with Playwright after the first build. |
| B4 | PASS (design) | Thumbnails from YouTube. Teacher photos webp at display size, measured. |
| B5 | Plan | One repo, one project, build master + staging only. |
| B6 | PASS (design) | Chat uses Realtime push. No polling anywhere. |
| B7 | Plan | Middleware matcher excludes static assets. |
| B8 | PASS | 100 DAU x 3,000 = 300k = 30% of the own 1M cap. Re-measure after the first build. Go Pro before 50% (~167 DAU). |
| B9 | PASS V1 / FAIL V2 | Free V1 on Hobby. Paid V2 needs Pro. |
| C | Plan | Rate limits on tutor + chat. Feeds, titles, transcripts, messages wrapped as untrusted before any model reads them. |
| D1 | PASS (design) | P1-P7 PM2 cron. |
| D4 | PASS (design) | Upserts on natural keys. Newsletter `send_key` first. |
| D5 | PASS (design) | P3 at 2 AM CST. |
| F4 | Plan | Per-run caps: P1 200 videos, P3 5 videos, P5 300 items. |
| F7 | PASS (design) | Teacher approves newsletter. Teacher approval required to become a teacher. |
| Privacy | Plan | Alias mode enforced in DB view + RLS. Test: student session can never read `real_name`. |

## 5. Risks and 10x
1. YouTube transcripts: Boss accepted ToS + contract risk. Technical risk: YouTube blocks the laptop IP. Bounded by 5/night and stop-on-block.
2. Community safety: moderation load on the teacher. Mitigation: broadcast mode default, report button, mute.
3. Alias leak: one wrong query exposes the real name. Mitigation: DB-level view + a test.
10x (5,000 DAU): Vercel edge requests (~15M / 30 days) break first. Fix: Pro + cache public pages. Second: Realtime peak connections over 500 ($10 per extra 1,000).
