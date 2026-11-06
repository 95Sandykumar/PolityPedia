# Student UI decisions (2026-11-06)

Calls made without Boss during the student screen polish. One line each.

- Follow button moved from under the tiles into the teacher hero card. Reason: the brief asked for hero = avatar, name, bio, exams, follow. DESIGN.md section 8 said "under the tiles". Easy to move back (one block in `teacher-portfolio.tsx`).
- Portfolio tiles are 128 px tall (DESIGN.md said 96) so the caption and the item count fit.
- Student content box widens to 880 px from 768 px screens (DESIGN.md said 560 px, one column) so lists can use 2 columns. Phone is unchanged. Bottom nav stays 560 px.
- Practice tab is no longer "Coming soon". It lists the followed teachers with Mock tests and Past papers links and a Saved row. No new route, no new data.
- Soft tints use the primary token at low opacity (`bg-primary/10`). No new colour token, no gradient.
- `bg-muted` was used in 3 places but `--muted` is not a token, so it painted nothing. Replaced by `bg-background`.
- Exam timer got `suppressHydrationWarning`: the clock text comes from `Date.now()`, so the server and browser differed by one second and React logged a hydration error on every exam load.
- The exam player action bar now parks above the fixed bottom nav (it was hiding behind it once the page scrolled).
- "Signed in as" on Me reads the e-mail from the student's own access token on the server. Display only.
- New files: `components/student-ui.tsx` (page header, section title, empty state, back link), `components/home-exam-card.tsx`, `components/practice-hub.tsx`, `app/(student)/_data/student-ui-data.ts` (read-only helpers that call existing readers).
- Every new label is in `src/lib/i18n.ts` in the block marked `// student-ui:` at the end of each language.
