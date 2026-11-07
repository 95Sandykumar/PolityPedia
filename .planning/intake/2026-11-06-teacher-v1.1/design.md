# PolityPedia v1.1: teacher onboarding and teacher tools (system design)

Date: 2026-11-06. Skill: system-design. Base: `web/supabase/migrations` 0002 to 0040, `web/src/app` routes (read this session).

## 1. Blockers (Boss decides, ticket H6)

| ID | Question | Option A (recommended) | Option B |
|---|---|---|---|
| D1 | What does "Delete" do? | Archive anything a student paid for or attempted (hidden, kept, restore in 30 days). Hard delete only empty drafts. | Hard delete everything, with a 7-day undo bin. Money records stay either way. |
| D2 | What is a "narrated" news post? | Written text (up to 2,000 chars) plus optional link with a preview card. Voice note = Upcoming. | Also a voice note upload (max 3 min) now. |
| D3 | How do students join a batch by link? | Teacher picks per link: open join or "ask to join". Default open. | Every join needs teacher approval. |
| D4 | Can students talk in a batch? | No. Teacher-only announcements (like a Telegram channel). Student chat = Upcoming. | Group chat now (needs moderation, report button, mute). |

Tickets 45, 46, 47, 49, 50, 53 run without these answers. Tickets 48, 51, 52 wait for H6.

## 2. What exists today (verified in code)

| Area | Exists | Gap |
|---|---|---|
| Teacher sign-up | invite code + admin approval (`0005_teachers.sql`, `/teacher-signup`, `/teacher/pending`) | No guided first-run. No progress checklist. |
| Profile photo | `teachers.photo_path` column | Nothing writes it. No upload API, no bucket. |
| Socials | none | No YouTube channel or Instagram handle fields. |
| Videos | `teacher_videos` YouTube id only, oEmbed title + thumb (`lib/videos/oembed-video-meta.ts`) | No Instagram reels, no Shorts flag, no exam tag. |
| News | `teacher_posts`: heading + link + priority | No body text, no link preview, no pin, no exam tag. |
| Mock tests | `mock_sets` > `mock_tests` > `questions` (`topic_id` uuid with no table) | No subject/topic list. No subject per test. No reorder, duplicate, bulk paste, preview. |
| Batches | join code, members, set access, reports (`0019`, `0020`) | No invite links with expiry/limit, no join requests, no announcements, no archive. |
| Delete | almost every FK is `on delete cascade` | **BUG**: `purchases.set_id` cascades (`0026_purchases.sql:113`). Deleting a mock set erases payment records, `set_access` and attempts. Deleting a paper erases attempts (`0013_attempts.sql:43`). |
| Analytics | batch report views (`0020_batch_reports.sql`) | No follower count, no topic accuracy, no "not attempted" list. |

## 3. Teacher journey (target)

1. Invite link from admin -> sign in (Google or 6-digit code) -> "Teacher" form -> pending screen.
2. Admin approves -> teacher lands on **Setup checklist** (5 steps, skippable, progress shown on Home until done):
   1. Photo (upload, crop square, max 2 MB, webp) or alias avatar.
   2. Name or alias, bio (EN/HI).
   3. Exams taught + next exam date.
   4. Channels: YouTube channel URL, Instagram handle (validated format only).
   5. First batch -> share link (WhatsApp, Telegram, copy, QR).
3. Daily use: post news, add videos, build mocks, check batch scores.

## 4. Data model changes (one migration per ticket)

| Migration | Ticket | Change |
|---|---|---|
| 0041_keep_money_and_scores | 45 | `purchases.set_id` -> `on delete restrict`. Add `archived_at timestamptz` to `mock_sets`, `mock_tests`, `papers`, `batches`. RLS: students do not see archived rows unless they hold `set_access`/attempts. RPC `archive_mock_set`, `restore_mock_set` (30 days), `delete_or_archive_*` picks hard delete only when no purchase, no attempt, no access row. |
| 0042_teacher_setup | 46 | `teachers.youtube_channel_url text check (^https://(www\.)?youtube\.com/(@[\w.-]{3,30}|channel/UC[\w-]{22})$)`, `instagram_handle text check (^[a-z0-9._]{1,30}$)`, `setup_done_at timestamptz`. Public bucket `avatars` (2 MB, image/webp,jpeg,png), path `<uid>/avatar.webp`, owner-only write. |
| 0043_videos_multi_platform | 47 | `teacher_videos`: add `platform text check in ('youtube','instagram') default 'youtube'`, `kind text check in ('video','short','reel')`, `url text`, `exam_id uuid null`, `is_visible bool`. `youtube_id` nullable; check: youtube rows need youtube_id, instagram rows need url matching `^https://(www\.)?instagram\.com/(reel|p)/[\w-]+/?`. Unique (teacher_id, platform, coalesce(youtube_id,url)). |
| 0044_news_v2 | 48 | `teacher_posts`: `body text (<=2000)`, `exam_id`, `pinned_at`, `link_title`, `link_image`, `link_site` (preview cache), `edited_at`. Max 3 pinned per teacher (trigger). |
| 0045_subjects_topics | 49 (editor UI = 50) | `subjects(id, exam_id, name_en, name_hi, position)`, `topics(id, subject_id, name_en, name_hi, position)`; FK `questions.topic_id -> topics`; `questions.subject_id`; `mock_tests.kind in ('full','subject','topic')`, `mock_tests.subject_id`, `mock_tests.topic_id`; `mock_tests.marks_correct/marks_wrong` nullable overrides (null = exam default). Seed Pol Sci units for UGC NET + CUET PG (UGC NET Pol Sci 10-unit syllabus). Teachers may add their own topics (`topics.teacher_id` null = platform list). |
| 0046_batch_invites | 51 | `batch_invites(id, batch_id, token, label, expires_at, max_uses, uses, needs_approval, revoked_at)`; `batch_join_requests(batch_id, user_id, status pending/approved/rejected, decided_at)`; `batches.member_cap`, `batch_members.role in ('student','helper')` (helper = Upcoming UI), `batch_bans(batch_id,user_id)`. RPC `join_by_invite(token)` is the only writer. Old 6-char codes keep working. |
| 0047_batch_announcements | 52 | `batch_posts(id, batch_id, author_id, body, link, pinned_at, created_at, edited_at)`; teacher writes; members read. |
| 0048_teacher_stats | 53 | Views: `teacher_follower_counts`, `batch_activity_7d`, `batch_topic_accuracy`, `batch_not_attempted`. Owner-only via security_barrier + `owns_batch()`. |

## 5. Edit and delete rules (per object, D1 option A)

| Object | Edit | Delete |
|---|---|---|
| Profile, socials, photo | any time | account delete = admin request (Upcoming self-serve) |
| Video, news post | any time (`edited_at` shown) | hard delete, no dependents |
| Batch | rename, settings, reset links | archive (members lose access to batch-granted sets; reports kept); hard delete if 0 members ever |
| Invite link | label, expiry, limit | revoke (people already in stay, like Telegram) |
| Mock set | draft: everything. Live: title, explanations, typos. Answer key: key-lock flow (0030) with re-score | archive if any purchase/attempt; buyers keep access until `valid_until`; hard delete if empty draft |
| Mock test / question | same as set; live question removal = archive, excluded from new attempts, kept in old results | as set |
| Past paper | as mock set | archive if attempts exist |

## 6. Mock editor feature list (research summary)

From competitor pages (Teachmint tests page, Classplus bulk upload, Testpress comparison, generic test platform requirement docs): question entry by typing, PDF upload, Word/bulk upload, question bank; preview before release; sections and negative marking are where simple tools fall short.

Build now (49, 50): subject/topic per test and per question; marks override per test; reorder (drag + up/down buttons); duplicate question/test; move question between tests; bulk paste text format (`1. stem / (A)..(D) / Ans: B / Exp: ...`) with a parse preview before save; image per question (existing `image_path`); EN + HI; preview as student; autosave; publish checklist (count, unchecked, missing key, missing topic warnings).

Upcoming: question bank reuse across sets, Word (.docx) import, AI question writer from notes, sections inside one test, random question order per student, shuffle options, schedule a test for a batch at a fixed time.

## 7. Check table (system-design step 4)

| ID | Result | Proof / note |
|---|---|---|
| A1-A6 money | PASS after 45 | 45 makes payment rows undeletable (restrict FK). No new money path. |
| B1 quota | PASS | Supabase Pro org. New: avatar storage (2 MB x teachers, tiny). Link preview fetch: 1 server call per post save, not per view. |
| B3 prefetch | carry | new pages use the existing link wrapper; Ralph must keep `prefetch={false}` pattern used in app. |
| B4 images | PASS by design | avatar resized to 256x256 webp on upload, server side (sharp already in Next). |
| B6 polling | PASS | join requests and announcements load on open; no polling. |
| B8 load | PASS | 100 DAU target; each feature adds under 10 requests per user per day. |
| C public endpoints | care | link preview fetch = SSRF risk: https only, block private IPs, 3 s timeout, 512 KB cap, store result, never fetch on student view. `join_by_invite` rate limit 10/min per user. |
| Reversible | PASS | each migration ships a rollback note at the top. |

## 8. Upcoming (not in v1.1)

YouTube auto-import (daily job: `channels.list` + `playlistItems.list`, 1 quota unit each, 10,000/day free), Instagram auto-import (needs teacher Business account + Meta app review), voice news, batch chat, co-teacher/helper role UI, scheduled posts, live class links with reminders, Telegram bot mirror of announcements, CSV export of scores, per-student timeline, predicted percentile, teacher earnings page, self-serve account delete.

## 9. Top 3 risks and 10x

1. Migration numbering clash between tickets: each ticket owns one fixed number (section 4).
2. 0040 not live yet: v1.1 migrations must apply after 0040; apply in order with `pgrun/apply.cjs`.
3. Archive hides content students expect: archived sets stay visible in "My purchases" for buyers.

10x (1,000 DAU): batch report views scan attempts per open; add index `attempts(test_id, user_id)` and a nightly materialized view if p95 > 500 ms.
