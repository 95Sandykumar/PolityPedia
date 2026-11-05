# PolityPedia notes

## 2026-11-04
- Phase 1 research done. See research/2026-11-04-market-research.md and research-decision-page.html.
- Recommendation: V1 = free subject hub (syllabus explorer, PYQ bank, daily quiz, mocks, AI tutor on teacher notes, weekly newsletter). No paid LMS clone in V1.
- Teacher stays anonymous. Brand = PolityPedia.
- Waiting on Boss decisions (decision console on the page).
- Next phase: UI/UX, then build with /dev-work + system-design skill, host on Vercel.
- Boss decisions: V1 free hub + AI tutor + newsletter; ALL four exams day one (NET, CUET PG, PGT, TGT); Hindi + English; PolityPedia brand, teacher anonymous.
- New inputs: RAG on past notes, YouTube thumbnail hub with student filters, video transcripts saved as numbered classes into RAG, newsletter pipeline, signups in Supabase or Sheet, minimum-text UI.
- Design draft 1 in design.md. Open: transcript source (YouTube captions need channel-owner OAuth), Vercel Hobby 1M cap, sample notes + video links, expected DAU, domain. No "wireframe" skill installed.
- Design draft 2: added News tab (P5, feeds PIB/MEA/The Hindu/IE tested HTTP 200, PRS 404), Teachers tab inside Videos with follows, YouTube channel RSS for discovery (0 API units), Supabase in Mumbai (all 4 current projects are us-east-1). Vercel cap is team-wide (vercel-health.ts:3-6); live usage pull returned HTTP 403, needs `vercel login`. Recommended: separate free Vercel account for PolityPedia.
- Live Vercel usage (CLI): 446,699 / 30 days (44.7%).
- Boss decisions draft 2: separate free Vercel account; transcripts pulled from YouTube (Boss accepts ToS + contract risk); Teachers = own tab (6 tabs); Supabase + Sheet copy; News once nightly.
- Draft 3: two-sided platform. Teacher profile: 3 YouTube + 2 Instagram, Public/Alias identity mode, communities with broadcast/allow-list/open posting, teacher dashboard. Instagram: links only in V1 (personal API dead since 2024-12-04). Realtime Pro: 500 concurrent.
- Teacher videos found (private file). ~1 Pol Sci long video a week, not daily.
- Draft 3 decisions: teachers invite only + admin approves (invite links teachers can forward); Instagram links only in V1; 100 DAU (B8 now PASS, 30%). Notes "10" unclear, asked. Domain: politypedia.vercel.app free and unclaimed; politypedia.app $9.99/yr 1 then $15; .com/.org taken; .in unverified. No email newsletter without own domain (Resend).
- Draft 4 decisions: free politypedia.vercel.app, newsletter = site + Telegram, 10 notes PDFs.
- Pricing (Boss): free for early users, then Pro Rs 500/month. Free = videos, teachers, news, community, daily quiz, 5 AI q/day. Pro = AI tutor (100/day fair use), full mocks, notes PDFs, score analysis. Build plans + entitlements now. Vercel Pro + Razorpay + money checks before first paid user. Open: early-user price after free period, Pro start date, teacher revenue share.
- v0 frozen: all research + design copied to versions/v0-2026-11-04/ (md5 checked). README.md there is the one-page summary. Root files are now the working copy for the next version.

## 2026-11-04 (v1 start)
- Boss sent the v1 iPad sketch (saved: research/2026-11-04-v1-sketch.jpg). Zoomed 11 crops, read 13 zones. 4 labels unclear: "PPP" tile, 0-100 bar label ("accronno"?), "Same as this pipe true", "NA" in the database.
- New in v1: mock tests are PAID. Teacher prices and packages them. Band Rs 299 to Rs 399. Exams: UGC NET, CUET PG, PGT, TGT.
- Price check (web search snippets, unverified): PW UGC NET series Rs 499 for 67 tests (~Rs 7/test). JRFAdda Pol Sci Paper 2 Rs 1,299, Paper 1+2 Rs 1,999. Adda247 437 tests, no price shown. Finding: the band only works per SET (10-15 full mocks), not per single test.
- Question page: v1-sketch-questions.html, published https://claude.ai/artifact/SC9r6PcWrQJVyL2JXhETb9 (24 questions, teacher pricing calculator). Waiting on Boss picks.
- Boss walkthrough (round 2), locked: 2 roles. Teacher makes many batches; a student can be in many batches. Student picks exam, adds teachers. Portfolio tiles = Videos, Past papers ("PPP"), Mock tests, Notifications + Subscribe. Videos = links only, thumbnail + title fetched, teacher Show / No show ("Coming soon"). Past papers stored Exam > Year > Month (optional) > PDF (questions, solutions or both), teacher uploads/edits; player = exam on top, 0-100 question bar, Reveal answer, same look as mock player. Mock list: tick + score if taken, Attempt; full paper or topic dropdown. Wrong: right answer + teacher explanation dropdown + Revision. Revision = AI (exam + topic + question, research, text + audio), Rs 100/month. No AI plan = answer + teacher explanation. Correct: Next + Mark for later.
- "100/mo" in the sketch = Rs 100 a month AI plan (not 100 questions).
- Page updated to round 2 (same URL): 15 locked parts, 14 open questions.
- Round 2 decisions (Boss, 2026-11-04):
  - Subscribe button renamed to "Follow" (free, gets the teacher's notifications).
  - Batch = access to chosen mock sets + batch scores for the teacher. Students join by link or code.
  - Past papers: AI splits the PDF into questions, teacher checks. EACH TEACHER KEEPS OWN COPY (explanations differ per teacher; only that teacher edits). Past papers free.
  - Next exam date: each teacher maintains it on their page.
  - Mock tests: practice mode + timed exam mode.
  - Pro Rs 500/month KEPT, alongside mock sets (Rs 299-399) and AI plan (Rs 100/month).
  - Teacher revenue share is a per-teacher deal. First teacher: 50/50. So share = a per-teacher setting, not one global %.
  - AI revision: one cheap, smart model via API, per-user limit. Context = question + teacher explanation + web search + other context. One explanation per question, saved and shared. Paid AI voice, saved. Platform keeps all of the Rs 100 AI plan.
- Round 3 (Boss, 2026-11-04):
  - Pro Rs 500/month = AI + notes + score analysis (as v0). Mock sets always sold separately. Rs 100/month = cheaper AI-only plan.
  - Teacher share (first teacher 50/50) covers MOCK SET sales only. Pro + AI money stays with the platform.
  - AI limit: 30 NEW explanations per user per day. Saved explanations do not count.
  - Architecture fully locked. Next: update design.md to v1, then create-prd.
- design.md rewritten as v1 draft 1 (system-design skill). AI price from claude-api skill: Haiku 5.5 $0.10/$0.50 per 1M tokens, web search $10 per 1,000. Est. $0.022 per new explanation (2 searches). B9 FAIL: Vercel Pro before first sale.
- v1-architecture.html drawn (infographic intake -> diagram-design, self_check OK, verify-geometry 0 findings). https://claude.ai/artifact/HSbKdt8sYBG5cvQBrK4LM3
- PRD-PolityPedia-v1.md written (create-prd skill). Build order S1 Foundation, S2 Past papers, S3 Mock tests (no pay), S4 AI revision, S5 Money.
- /dev-work started for the backend. Step 0 blocked: PolityPedia has no git repo and no PROJECT-REGISTRY entry. Asked Boss where the app repo goes.
- UI design guide (ui-ux-pro-max): ui-design-guide.md + preview https://claude.ai/artifact/FpTH6xPCFC2dUR3cbC5CcF. Style Minimalism/Swiss, indigo primary, Noto Sans Devanagari, 5 picks D1-D5 open.
- Incident: writing DESIGN.md overwrote design.md (Windows filenames are case-insensitive). Restored design.md from session content; UI guide renamed ui-design-guide.md.
- UI design guide FINAL (Boss picks from the design lab, 2026-11-04): Clean Swiss, indigo #4F46E5, no gradient, Noto Sans Devanagari 16 px, radius 10, spacing 12, outline answers, border cards, light only in v1, green/red. D1 5 tabs, D2 bar + number grid, D3 same screen, D6 language toggle in one place (Me > Language + first sign-in). Alternate look (Hind, #1D4ED8, blue/orange) saved as section 13, not used. Ralph scheduling is now unblocked from the UI side.
