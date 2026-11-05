---
id: 01-app-shell
status: todo
type: afk
depends_on: []
---
# App shell: Next.js in web/, design tokens, 5-tab student nav

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
A student opening the app on a 360 px phone sees the PolityPedia shell in the final design: indigo tokens, Noto Sans Devanagari, and a bottom nav with 5 tabs (Home, Teachers, Practice, Saved, Me) in English or Hindi. `npm test` and `npm run build` pass inside `web/` with NO environment variables set.

## Vertical slice
- Create a Next.js (App Router, TypeScript) app in `web/` with Tailwind and shadcn/ui base. Use the latest Next.js (16.4.5 or newer, `npm view next version`). Vercel refuses to build older versions with known holes ("Vulnerable version of Next.js detected", seen 2026-11-05 on 15.5.4).
- The app is deployed overnight as a Vercel preview with root directory `web/` and no env vars. `npm run build` must pass with no `.env` file, and every page must render without Supabase keys (use the fakes or a "not configured" state).
- Copy the repo root `ui-design-guide.md` to `web/DESIGN.md` unchanged. Write `web/CLAUDE.md`: first line `@DESIGN.md`, then the conventions in the Context section of this issue (fakes, PGlite, migration naming, i18n, `npm test`).
- CSS variables for every light token in DESIGN.md section 3 (light column only; v1 is light only). Radius 10 px, gap 12 px, no shadows, no gradients.
- Font: Noto Sans Devanagari through `next/font/google`, subsets latin + devanagari, weights 400, 500, 700 only.
- Small i18n module: dictionary `en` and `hi`, mode `en | hi | both` (both = English with Hindi under it). Default `en`.
- Student layout with the bottom nav (Lucide icons 24 px, 48 px touch targets, safe-area inset). Tabs link to placeholder pages.
- Vitest + Testing Library set up as `npm test`. Any Supabase or env access is lazy, so the build works without env vars.

## Test that proves it
`npm test`: a test renders the student layout and finds exactly 5 tab links with the English labels, and with Hindi labels when mode is `hi`. `npm run build` exits 0 with no env vars.

## Design constraints
- DESIGN.md: tokens only, no raw hex in components. Light only. 5 tabs (D1). Touch targets 48 px.
- B3: no viewport prefetch on links (use `prefetch={false}` or a hover/focus prefetch wrapper).

## Notes / scope guard
Only the shell. No sign-in, no database, no real pages behind the tabs.
