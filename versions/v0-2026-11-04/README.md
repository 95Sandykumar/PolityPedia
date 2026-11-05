# PolityPedia Version 0 (frozen 2026-11-04)

This folder is a frozen copy. Do not edit it. Work on the next version happens in the project root.
Use it to look up what we researched and decided for v0, or to go back to the v0 plan.

## What v0 is (one line)
A free web hub for Political Science exam students (UGC NET, CUET PG, PGT, TGT), plus an AI tutor that answers only from the teacher's notes and classes. Teachers and students both use it. The founding teacher stays anonymous.

## Files

| File | What it holds | Public? |
|---|---|---|
| research/market-research.md | Reference app, competitor prices, exam pattern, UGC NET cut-offs | Internal |
| research/PRIVATE-teacher-videos.md | Teacher's real name, video links, channel ID, Instagram, Telegram, name filter | **PRIVATE. Never publish.** |
| design/design.md | Full system design: requirements, limits, pipelines P1-P8, data model, checks, risks, pricing impact | Internal |
| design/decision-log.md | Every decision in time order (copy of notes.md) | Internal |
| pages/1-research-decision-page.html | Phase 1 visual research page | Internal |
| pages/2-pipeline-design-page.html | Visual system design, draft 5, with decision console | Internal |

Live published pages (same content as pages/):
- Research: https://claude.ai/artifact/6vhh7DRgNYtoHpyXE3Uavz
- System design draft 5: https://claude.ai/artifact/J9SwjSXCtDcd4i5hxRWLPy

## Key facts (checked 2026-11-04)

| Topic | Fact |
|---|---|
| Reference app | Play Store `co.thanos.lpuon`, AppX white label, 10K+ downloads, 4.3 stars, 16 reviews |
| Competitor prices | Adda247 Pol Sci: crash Rs 2,617, video Rs 2,625, foundation Rs 3,359, 3X Rs 6,825. Testbook Rs 14,499. Unacademy from Rs 1,547/month |
| CUET PG paper | HUQP18: 75 MCQ, 300 marks, +4/-1, 90 min |
| UGC NET June 2026 Pol Sci cut-offs (JRF / AP / PhD) | UR 222/196/170. OBC 212/180/156. EWS 214/180/150. SC 202/168/148. ST 194/160/142 |
| Teacher upload rate | About 1 Pol Sci long video a week (not daily) |
| YouTube API | 10,000 units/day. Channel RSS = 0 units, last 15 videos only. `captions.download` needs owner OAuth |
| Instagram | Personal API dead since 2024-12-04. Only links in V1 |
| Email | Resend needs our own domain. No email newsletter on vercel.app |
| Vercel old team | 446,699 of 1M requests in 30 days (44.7%). Cap is team wide, so PolityPedia gets its own free account |

## Locked decisions

| Area | Decision |
|---|---|
| V1 scope | Free hub + AI tutor (RAG over notes, class transcripts, PYQs) + newsletter |
| Exams | All 4 on day one |
| Language | Hindi + English |
| Brand | PolityPedia. Teacher anonymous |
| Tabs (6) | Home, Videos, Teachers, News, Practice, Ask |
| Hosting | politypedia.vercel.app on a separate free Vercel account. Region bom1 |
| Backend | Supabase Mumbai (ap-south-1): Auth, Postgres + RLS, pgvector, Storage, Realtime |
| Signups | Supabase + nightly read-only Google Sheet copy |
| Videos | Thumbnails + filters YouTube lacks. Each video = numbered class in the RAG |
| Transcripts | Pulled from YouTube. Boss accepts ToS + Adda247 contract risk. Max 5 a night, stop on first block |
| News | Once a night (2 AM IST), 5 feeds, top 10, own-words summary EN/HI |
| Newsletter | Weekly. AI drafts Saturday, teacher approves, Sunday 7 AM IST on site + Telegram |
| Teacher profile | 3 YouTube + 2 Instagram links. Public or Alias mode |
| Groups | Discord/Telegram style. Teacher decides who can post |
| Teacher signup | Invite only. Admin approves. Teachers forward invite links |
| Notes | 10 PDFs from the teacher |
| Load | 100 daily students at start |
| Pricing | Free for early users. Then Pro Rs 500/month |
| Free tier | Videos, teachers, news, community, daily quiz, 5 AI questions/day |
| Pro tier | AI tutor (100/day), full mocks, notes PDFs, score vs cut-off |

## Open at freeze time
1. Early users after the free period: locked Rs 299/month (recommended) or free forever.
2. Pro start: after UGC NET Dec 2026 (recommended) or at 500 signups.
3. Teacher revenue share.
4. Vercel terms on a second Hobby account: unverified.
5. Correct PRS news feed URL (rss.xml gave 404).
6. Embedding provider that handles Hindi: not chosen.

## Before charging money (from design.md)
- Vercel Pro (Hobby is non-commercial).
- Razorpay Subscriptions + UPI autopay, money checks A1-A6, daily reconcile job P8.
- Check the teacher's Adda247 contract.

## How to reuse v0
- To start a new version: copy this README's "Locked decisions" table, then mark what changed.
- To build from v0: give `design/design.md` to the create-prd skill, then /dev-work slice by slice.
- To check a fact again: each fact above has its source in `research/` or `design/design.md`.
