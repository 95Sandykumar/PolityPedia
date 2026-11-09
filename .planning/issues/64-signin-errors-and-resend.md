---
id: 64-signin-errors-and-resend
status: done
type: afk
depends_on: []
---
# Sign-in shows why it failed, and lets you resend the code

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 7 and steps 2, 3a, 3b, 3c. DB tests use PGlite. Auth is faked in tests. Strings in EN and HI.

Today the Google callback sends `?error=denied|no_code|expired|failed|not_configured` but the sign-in page never reads it. The code step has no resend, no timer and no spam hint. Every wrong code shows one generic line.

## Definition of done
1. The sign-in page reads `?error=` and shows a plain message for each of the five reasons.
2. The code step has "Resend code" with a 30 second cooldown, a "Check your spam folder" hint, and an expiry line. Check the real code lifetime in the repo's auth setup notes or config before writing the number. If it cannot be verified, say "The code expires soon".
3. A wrong code and an expired code show different messages when the verify route can tell them apart.
4. If the email provider rate limit is hit, the page says to wait and try again (the built-in sender allows about 2 emails per hour).

## Vertical slice
- UI: error banner, resend button with cooldown, hints
- service: map verify-route failures to message keys

## Test that proves it
Component tests for each error key, the cooldown (fake timers), and wrong versus expired code. The send-code route still returns the same reply for known and unknown emails. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
C: no account enumeration; keep the identical reply for known and unknown emails. Never print a code or token in the UI or logs.

## Notes / scope guard
No new sign-in method, no password.

<!-- ralph 2026-11-09T19:22:36.372Z: committed + tests pass -->
