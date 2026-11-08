# PRD: PolityPedia student journey v1.2 (lean)

Date: 2026-11-08. Source: three read-only student walks in `walk/persona-1..3.md` (44 steps, file and line proof). Decision page: https://claude.ai/artifact/KXCxrgSu6NsYfxxi4D51EA

## Problem
The student side works on paper but is not safe to sell. After paying, the screen does not change. Exam answers are lost silently when the network drops. Every test ends on a one-line score. Errors look like empty lists. Nothing brings a student back tomorrow.

## Goals (a student can...)
1. See a real error and a Retry button when something fails, never a false "no tests yet".
2. See a result page with right, wrong, skipped, time and the wrong questions, and review a finished sitting without starting a new one.
3. Sit a timed exam with a start screen, an offline-safe answer queue and a submit confirm.
4. Pay and see what happens: checking, then access, or a clear "you were not charged". No second order while one is pending.
5. Land on a real public page, sign in with clear errors, and keep a join link through sign-in.
6. Find teachers for their own exam and spot the free sample.
7. Come back: Continue card, progress, streak, revise saved questions with spaced repetition, topic practice, installable app.
8. Have a name the teacher can see in batch reports.

## Non-goals
- Push notifications (needs a key from Boss: H9).
- Student chat, social features, leaderboards.
- New payment providers or price changes.
- Any change to teacher tools (tickets 46 to 53 own those).
- Applying migrations to the live database (human ticket H7).

## Constraints
- Web app is in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Strings in EN and HI through the existing i18n file.
- Migrations: student tickets own 0049 to 0054, one number each. Teacher tickets own 0042 to 0048.
- No real network or Razorpay calls in tests. DB tests use PGlite.
- Phone first (390 px wide), 48 px touch targets, `prefetch={false}` pattern on links.
- A page view must not write data. Sittings start on a Start tap.

## Risks
1. Launch trap: code reads `archived_at` (0041) and live DB lacks it. Human ticket H7 fixes order.
2. File overlap: `mock-list.tsx`, `exam-player.tsx`, the student Home page. Serialised with `depends_on`.
3. Service worker caching authed pages. The worker caches only an offline shell, never API or HTML for signed-in pages.
4. Money path: S4 touches checkout. Server keeps quoting price. Client never sends an amount.
