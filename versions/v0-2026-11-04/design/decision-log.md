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
