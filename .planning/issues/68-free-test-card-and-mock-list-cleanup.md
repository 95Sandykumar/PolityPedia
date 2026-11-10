---
id: 68-free-test-card-and-mock-list-cleanup
status: blocked
type: afk
depends_on: [62-prepay-card-and-my-purchases, 63-public-landing, 67-teachers-filter-and-free-badge]
---
# "Start your free test" and a calmer mock list

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 steps 5, 8 and gap 9. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today Home never shows the free sample. The mock list has a topic dropdown with one option, a coupon box shown to everyone, and no line saying what Practice versus Exam means.

## Definition of done
1. Home for a student who follows nobody shows a "Start your free test" card linking to the first live free sample for the student's exam. No free sample for that exam: no card.
2. The mock list drops the dead topic dropdown (topics return in ticket 76).
3. The coupon box shows only after the student taps "Have a coupon?".
4. One line explains Practice (no timer, answers show) versus Exam (timed, answers at the end).

## Vertical slice
- service: free sample pick for the student's exam
- UI: Home card, mock list cleanup
- i18n: EN and HI

## Test that proves it
Reader test for the pick (own exam, first live free sample, none). Component tests for the coupon toggle and the removed dropdown. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
B3 prefetch wrapper. The price and coupon logic are unchanged (A: server quotes the price).

## Notes / scope guard
No topic filter. No Home Continue card (ticket 69).

<!-- ralph 2026-11-09T18:51:51.073Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.228Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T23:38:30.975Z: upstream 67-teachers-filter-and-free-badge blocked -->
