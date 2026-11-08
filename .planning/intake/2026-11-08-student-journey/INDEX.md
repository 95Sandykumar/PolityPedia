# Student journey walk (2026-11-08)

Read-only walk of the student side by three personas. Dev server on localhost:3000, demo student account, live Supabase data.

| File | What it is |
|---|---|
| walk/persona-1-new-aspirant.md | Riya: landing, sign-in, onboarding, find teacher, free sample, result (12 steps) |
| walk/persona-2-daily-practicer.md | Arjun: home, practice, saved, papers, revision, me, day 2 (14 steps) |
| walk/persona-3-buyer-batch.md | Meera: paywall, pay, batch join, timed exam, teacher view (18 steps) |
| walk/shots/ | 29 phone screenshots. p3-03 and p3-09 are STALE copies from 2026-11-06 |
| walk/dev-server.log | Output of the local dev server start (it failed to bind once because one was already up) |

Top finding: live DB lacks migration 0041, code reads `archived_at`, lists show empty. Apply 0040 and 0041 before pushing the matching code.

Side effect: attempt row 44dbcf0b-7557-4254-80a2-acade79e122d was created for the demo student. `node web/demo/unseed.cjs` removes it.

Proposed tickets S1 to S11 are on the decision page (Artifact). Not yet written to `.planning/issues/`.
