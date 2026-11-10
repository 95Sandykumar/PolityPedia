---
id: 62-prepay-card-and-my-purchases
status: todo
type: afk
depends_on: [60-after-pay-screen]
---
# Pre-pay facts card, My purchases, Plans explainer

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-3 gaps 5 and 7, step 4. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

Today the Rs button asks for trust with no facts. There is no receipt list, no refund line, no support path. The Plans page can be mistaken for the way to unlock a teacher's mocks.

## Definition of done
1. Before paying, the set card shows: number of tests, total questions, minutes per test, marking, "access until" (computed as the grant would compute it), and the price that will be charged.
2. A "Refund and support" line reads from one i18n constant. Until human ticket H8 supplies the text, the constant is a clearly marked placeholder ("Refund policy: coming soon. Support: set by PolityPedia."). Do not invent a policy.
3. Me has "My purchases": set name, date, amount, status (paid or refunded), access until, and a support link from the same constant.
4. The Plans page says in one line that Plans do not unlock a teacher's mock sets.

## Vertical slice
- service: set facts reader, purchases reader (own rows)
- UI: facts card, My purchases page, Plans line
- i18n: EN and HI

## Test that proves it
Reader tests; component tests; PGlite RLS: a student sees only their own purchases. The price shown equals the server quote. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
A: do not write "incl. GST" anywhere. The tax rule is marked unverified (0027 X4). Say "price charged". Never expose another student's data. B3 prefetch wrapper.

## Notes / scope guard
No email receipt, no invoice PDF, no refund button.

<!-- ralph 2026-11-09T18:51:51.070Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-09T21:25:09.225Z: upstream 56-result-page blocked -->

<!-- ralph 2026-11-10T00:05:26.308Z: upstream 54-visible-read-errors blocked -->

<!-- ralph 2026-11-10T02:33:51.588Z: upstream 54c-read-errors-saved-practice-media blocked -->

<!-- ralph 2026-11-10T16:14:47.501Z: upstream 60-after-pay-screen blocked -->
