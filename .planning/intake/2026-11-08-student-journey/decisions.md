# Student journey v1.2: decisions (2026-11-08)

| Decision | Status | Answer | Why |
|---|---|---|---|
| Work order | settled | A: student safety tickets first, then teacher 46 to 53 | Boss, from the decision page. No student can safely pay until errors, results, exam safety and payment trust are fixed. |
| Which tickets go in the queue | settled | All 11 (S1 to S11), all "first night" | Boss, from the decision page. Ralph still runs them in dependency order over as many nights as it takes. |
| S9 (topics) and S11 (student name) | settled | Wait for teacher 49 and teacher 53 | They need the subjects/topics table (0045) and the teacher analytics (0048). They run after the teacher chain. |
| Old Ralph night branches (5) and 47 review cards | settled | Go on, do not clear first | The 5 branches hold only issue status line edits (about 28 files each, no app code). Code is already on local main. Boss answered "Go on". |
| Schedule | settled | Tonight | Boss answered "Tonight". Nothing is pushed. Review in the morning. |
| S10 scope | settled | Install only (manifest, install prompt, offline shell) | Push reminders need a push key only Boss can create. Push becomes human ticket H9. |
| Migration numbers | settled | Teacher tickets keep 0042 to 0048. Student tickets use 0049 to 0054, one number per ticket | One fixed number per ticket avoids clashes (same rule as teacher v1.1). |
| Applying migrations to live | settled | Human only. H7 applies 0040, 0041, then each new one, then pushes | Walk found live DB lacks 0041 while code reads `archived_at`. Never push code before the migration. |
| Refund policy and support contact | open | Boss writes the text (H8). Ralph builds the slot with a marked placeholder | No refund policy exists in the app. Ralph must not invent one. |
| GST wording | open | Do not claim "incl. GST" until X4 in 0027 is resolved | `0027_ledger.sql:71-76` marks the tax rule unverified. Show "price charged" only. |
| Test gate | settled | `node node_modules/vitest/vitest.mjs run`, `npm run typecheck`, `npm run build` in `web/`, `NODE_ENV=test` | Repo's own scripts. No real Razorpay or network calls in tests. |
