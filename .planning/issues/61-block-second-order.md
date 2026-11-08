---
id: 61-block-second-order
status: todo
type: afk
depends_on: []
---
# No second order while a payment is pending

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`. Evidence: walk persona-3 gap 4. This ticket owns migration **0049** only. DB tests use PGlite. Do not apply the migration to the live database.

Today `start_set_purchase` checks "already owned" from set access only. A slow payment confirmation leaves access closed, so a second tap creates a second purchase and a second Razorpay order. UNVERIFIED by test in the walk: write the failing test first.

## Definition of done
`start_set_purchase` refuses a new order for the same student and set while a purchase with status `created` younger than 15 minutes exists. It returns a clear "payment pending" outcome (and the pending order id so the UI can reopen it). Older `created` purchases do not block. Owned, own-set, coupon and live checks are unchanged. The checkout route maps the new outcome to the message "A payment for this set is already in progress."

## Vertical slice
- schema: `0049_block_second_order.sql` (rollback note at the top) changes the function
- service: checkout route maps the outcome
- UI: the mock list shows the message (reuse the existing error line)

## Test that proves it
PGlite: second call within 15 minutes returns pending; after 15 minutes a new purchase is made; a paid purchase is untouched; a coupon is not spent twice. Route test for the message. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
A1 to A6: this function never sets a purchase to paid and never touches the ledger. The price is still quoted by the database, never by the client.

## Notes / scope guard
Do not apply 0049 to the live database (human ticket H7). Do not change the webhook.
