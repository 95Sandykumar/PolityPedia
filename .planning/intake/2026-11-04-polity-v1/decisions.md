# Dev work decisions: PolityPedia v1 (2026-11-04)

Base commit: c981c21187b8911350aa2c7381ac9a16eed83b61 (docs only).
Product decisions: see ../../../notes.md rounds 1 to 3 and the UI guide picks. They are not repeated here.

| Decision | Answer | Why |
|---|---|---|
| Repo | Whole PolityPedia folder, branch main | Boss pick |
| Git identity | Sandeep Kumar / 95sandeepkumar95@gmail.com, repo-local | Boss pick ("Use my Gmail"); name copied from the Crown & Canvas repo config |
| Build mode | Ralph tonight (and following nights) | Boss: "I just want to schedule tickets" |
| Scope | All 5 slices S1 to S5, frontend + backend in the same vertical slices | Boss pick |
| App folder | `web/` (Next.js app one level down, like POFlow) | Keeps docs at the root. Ralph's gate finds `package.json` one folder down |
| DB tests | PGlite (Postgres in the test process) + an `auth.uid()` stub. No Docker, no cloud | Boss pick. Ralph runs alone overnight |
| External services | Supabase, Claude, Razorpay, YouTube, TTS: all behind small interfaces, faked in tests | No live key at night (question bank section 5) |
| Live keys, accounts, real money | `type: human` tickets H1 to H5 | Question bank section 4 and 6 |
| S5 money code | Built with defaults X1 manual payout, X3 share on net, X6 same cap for Pro. Test mode only | Reversible. Going live stays gated by H5 (X4 GST, X8 contract, B9 Vercel Pro) |
| Auth | Supabase Auth: Google or email OTP (v0 F1) | v0 design |
| Model per ticket | sonnet by default | Question bank section 7 |
| Commit | Ralph commits on its night branch. Never pushes | dev-work rule |
| Click-to-approve decision page | Skipped | Boss chose the mode (tonight) and approved the commit in words in this session. Board is in issues/README.md |
