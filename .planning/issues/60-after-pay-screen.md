---
id: 60-after-pay-screen
status: blocked
type: afk
depends_on: [54-visible-read-errors, 57-review-and-retake]
---
# After the pay window: checking, access, or "you were not charged"

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-3 gap 2 and steps 5, 6, 8. Razorpay and the database are faked in tests. Do not apply migrations to the live database. Strings in EN and HI.

Today the mock list opens the Razorpay window without a "paid" or "dismissed" handler. After paying, the list stays locked until a manual reload. After a failure the page says nothing.

## Definition of done
After the Razorpay window closes the mock list shows "Checking your payment..." and reads set access at most every 3 seconds for up to 30 seconds (10 reads at most). When access arrives: unlock and show "Payment received. Your tests are open." If access has not arrived after 30 seconds: "We have your payment request. Access can take a few minutes." with a "Check again" button (read only). If the window is dismissed or the payment fails: "Payment did not go through. You were not charged." with "Try again". The free-coupon path opens the set at once, with no reload.

## Vertical slice
- UI: paid and dismissed handlers wired in the mock list, status banner
- service: bounded access poll (read only)
- i18n: EN and HI

## Test that proves it
Fake checkout client and fake access reader (fake timers): paid then access arrives, paid but slow access, dismissed, failed, free coupon. Polling stops at 10 reads and on unmount. "Check again" never creates an order. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
A (money): the client sends only the set id and coupon, never an amount. Access comes only from the server read, never from the browser callback alone. B6: bounded polling as above. No real Razorpay calls in tests.

## Notes / scope guard
No receipt or refund UI (ticket 62). The pending-order block is ticket 61.

<!-- ralph 2026-11-09T18:51:51.067Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.222Z: upstream 56-result-page blocked -->
