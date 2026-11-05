# PolityPedia UI design guide (v1 FINAL, 2026-11-04)

File name note: becomes `DESIGN.md` in the app repo. Here it is `ui-design-guide.md` because Windows treats `DESIGN.md` and `design.md` (system design) as one file.

Status: **FINAL.** Boss approved it on 2026-11-04 with the design lab (https://claude.ai/artifact/FpTH6xPCFC2dUR3cbC5CcF). The app repo's CLAUDE.md imports it with `@DESIGN.md`, and every UI issue follows it. A change needs Boss's approval and a new version line here.

## 0. Locked tokens (from the design lab, Boss's pick)

| Setting | Value |
|---|---|
| Style | Clean Swiss |
| Main colour | `#4F46E5` (indigo) |
| Gradient | Off |
| Font | Noto Sans Devanagari |
| Base text size | 16 px |
| Corner radius | 10 px (cards, buttons, options, inputs). Pills 999 px |
| Spacing | Normal: 12 px gap and card padding |
| Answer buttons | Outline (1 px border, white fill, primary border when selected) |
| Cards | Thin border, no shadow |
| Theme | Light only in v1 (dark tokens kept below for later) |
| Right / wrong colours | Standard green / red |

```json
{"p":"#4F46E5","p2":"#7C3AED","grad":"off","font":"Noto Sans Devanagari","fs":16,"r":10,"gap":12,"opt":"outline","surf":"border","theme":"light","ans":"std"}
```
`p2` is not used, because the gradient is off.
Built with the `ui-ux-pro-max` skill (searches listed at the end). Screens come from `PRD-PolityPedia-v1.md` section 7.1.

---

## 1. Who and where

- Users: postgraduate aspirants aged 21 to 35 and their teachers. Serious study, not a kids' app.
- Device: cheap Android phone, Chrome, 360 px wide, 4G that drops. Teachers also use a laptop for uploads.
- Languages: Hindi and English. Every label exists in both. Numbers always in Latin digits (12/100, ₹399).
- Rule: **minimum text.** An icon plus 1 to 3 words. No paragraphs on any working screen.

## 2. Style

**Minimalism / Swiss** (skill result for "adult test preparation edtech focused minimal"): clean, high contrast, grid-based, flat, white space, one clear action per screen.
- No shadows on cards, a 1 px border only. Radius 10 px for cards, buttons, options and inputs. 999 px for pills.
- No gradients anywhere.
- Rejected: the first skill result, "Claymorphism" with Comic Neue. It is made for children's apps.

## 3. Colour tokens

Base: skill palette "Language Learning App" (indigo + green). Changes: background made neutral, amber taken from the "LMS" palette for Marked, dark theme added. Contrast was measured, ratios below.

| Token | Light (v1) | Dark (later) | Use | Contrast (measured) |
|---|---|---|---|---|
| `--background` | `#F8FAFC` | `#0B1120` | page | |
| `--card` | `#FFFFFF` | `#111827` | cards, player | |
| `--foreground` | `#0F172A` | `#E2E8F0` | body text | 17.06 / 15.27 |
| `--muted-foreground` | `#475569` | `#94A3B8` | secondary text | 7.24 / 7.34 |
| `--border` | `#E2E8F0` | `#1F2937` | 1 px lines | |
| `--primary` | `#4F46E5` | `#818CF8` | main buttons, progress, links | white on primary 6.29; dark text on dark primary 6.31 |
| `--correct` | `#15803D` text, `#16A34A` icon/border | `#4ADE80` | right answer | 5.02 on white; 10.81 dark. Never white text on `#16A34A` (3.3, fails) |
| `--correct-soft` | `#F0FDF4` | `#052E16` | right answer fill | `#15803D` on it 4.79 |
| `--wrong` | `#B91C1C` text, `#DC2626` icon/border | `#F87171` | wrong answer | 6.47 on white; 6.81 dark |
| `--wrong-soft` | `#FEF2F2` | `#450A0A` | wrong answer fill | `#B91C1C` on it 5.91 |
| `--marked` | `#B45309` | `#FBBF24` | Mark for later, timer warning | 5.02 on white |
| `--ring` | `#4F46E5` | `#818CF8` | focus outline 2 px | |

Rules:
- Colour never works alone. Right = green + ✓ icon + the word "Correct". Wrong = red + ✗ icon + "Wrong".
- Green and red are only for answers. Buttons are never green or red, except a destructive "Delete" (red outline).
- Components use tokens only. No raw hex in components.

## 4. Type

- Family: **Noto Sans Devanagari** (one family for Hindi and English; Latin glyphs come from Noto Sans). Loaded with `next/font/google`, subsets `latin` + `devanagari`, weights 400, 500 and 700 only (4G budget).
- Rejected: Lexend + Source Sans 3 (skill pairing "Corporate Trust"). It is good for English but has no Devanagari, so Hindi headings would fall back to a different font.

| Role | Size / line height | Weight |
|---|---|---|
| Page title | 22 / 28 | 700 |
| Section title | 18 / 24 | 700 |
| Question text | 17 / 26 | 500 |
| Body, options | 16 / 24 | 400 |
| Label, meta | 14 / 20 | 500 |
| Smallest (badges only) | 12 / 16 | 500 |

- Never below 16 px for anything a student must read to answer.
- `font-variant-numeric: tabular-nums` on scores, timers and prices.
- Hindi text gets line height +2 px (taller glyphs).

## 5. Spacing, layout, touch

- 4 px grid. Spacing scale: 4, 8, 12, 16, 24, 32.
- Default gap between blocks and card padding: **12 px** (Boss pick: Normal).
- Page gutter 16 px. Max content width 560 px for students (one column), 1120 px for the teacher dashboard (two columns on laptop).
- Touch targets: 48 px tall minimum. Answer options 56 px minimum, full width, 8 px apart.
- Sticky bottom action bar on the player (Next, Mark for later), with the safe-area inset added.
- Breakpoints: 360 (base), 768, 1024. No horizontal scroll at any width.

## 6. Icons and motion

- Icons: **Lucide** (shadcn default), outline style, 20 px in lists, 24 px in nav, stroke 2. No emoji as icons.
- Motion: CSS transitions only, no GSAP (skill dial motion 3/10; saves bundle size on 4G). Tap feedback 100 ms, panels 200 ms ease-out, exit faster than enter. Everything off under `prefers-reduced-motion`.

## 7. Navigation

- Student bottom nav, **5 tabs** (bottom nav limit is 5): Home, Teachers, Practice, Saved, Me. Videos and news open from Home and the teacher page. *(D1: locked.)*
- Back always works (browser history kept). Every test, question and teacher page has its own URL.
- Teacher dashboard: left sidebar on laptop, the same 5 slots as a bottom nav on phone: Home, Papers, Mock sets, Batches, Profile.
- Language: **one toggle in one fixed place**, not on every screen (Boss pick). Place: Me tab > Language, with 3 choices: English / हिंदी / Both. The student also picks it once on the first sign-in screen. The choice is saved to the profile, so it follows the student to every device.

## 8. Screen rules

**Teacher portfolio (student view).** Header: photo or alias avatar, name, next exam date pill. 2 x 2 tile grid: Videos, Past papers, Mock tests, Notifications (icon + 1 word, 96 px tall). Full-width **Follow** button under the tiles (primary; becomes outline "Following ✓"). Videos tile in "No show" state reads "Coming soon" with a muted style and no tap.

**Mock test list.** Set header with price or "Unlocked". Rows: test name, score `64/200` (tabular), ✓ when taken, button `Attempt` or `Review`. Locked rows show a lock icon and one "Unlock ₹399" button for the whole set. Above the list: Topic dropdown (Full paper by default) and a 2-way switch Practice | Exam.

**Question player.** Top: exam name (14 px muted), progress bar + "12 / 100", timer on the right in Exam mode (turns amber under 5 minutes). Question card. 4 option buttons with a letter badge (A, B, C, D). Tap selects (primary border). Bottom bar: Mark for later (bookmark icon), Reveal answer (past papers only), Next. Exam mode: the progress bar stays on top, and tapping it opens a question-number grid (answered, marked, not seen) *(D2: locked)*.

**Right / wrong result.** The result shows on the same screen, under the options, with no page load *(D3: locked)*. Wrong: ✗ "Wrong", right option highlighted green, the chosen one red. "Teacher explanation" accordion (closed). Primary button **Revision (AI)**, secondary Next. Right: ✓ "Correct", Mark for later, Next.

**Revision (AI).** While loading: a skeleton plus "Writing explanation..." (`aria-busy`). Saved explanations open instantly. Layout: Exam · Topic chips, the question in short, explanation sections with headings, Sources (links), audio bar (play/pause, 1x / 1.25x / 1.5x speed). Thumbs up/down under it (feedback goes to the teacher). Not on a plan: one card "AI explanation ₹100/month" with Subscribe, and the teacher explanation stays visible. Limit reached: "30 new explanations used today. Saved ones still work."

**Teacher: PDF upload and review.** Drop zone + "Choose PDF" (max 30 MB). Job progress live ("Splitting... 42 questions found"). Review screen: on a laptop, the PDF page on the left and the question form on the right; on a phone, a tab switch "PDF | Question". Each question shows Draft / Checked. Publish stays disabled until every question is checked.

**Teacher: price a set.** Stepper ₹299 to ₹399 in steps of ₹10 (numeric keypad). A live line under it: "You get about ₹X per sale" from the teacher's share. Free sample switch on Test 1. Batches with free access as checkboxes.

**Batches.** List with the student count and a copy-link button. Batch page: join link + code, students, sets given, score table.

## 9. States (every screen)

| State | Rule |
|---|---|
| Loading | Skeleton the shape of the content. No spinner over 300 ms on a blank page |
| Empty | One icon, one line, one action ("No tests yet. Teacher adds them soon.") |
| Offline | Top banner "No internet. Answers are saved and sent when back." The answer queue retries |
| Error | Says what went wrong and the fix, next to the thing that failed |
| Success | Short toast, 2 seconds ("Saved", "Published") |

## 10. Performance budget (4G)

- First load JS for student pages: 150 KB gzipped or less (target, measured with `next build`).
- One font family, 3 weights, 2 subsets.
- Images: YouTube thumbnails as plain `<img loading="lazy">` with width and height set (v0). Question crops webp, max 1200 px.
- A test loads in 1 request, so the player never waits between questions.

## 11. Accessibility checklist (pre-delivery)

- [ ] Text contrast 4.5:1, icons and borders 3:1 (tokens above measured)
- [ ] Every icon-only button has an `aria-label` in the current language
- [ ] Visible focus ring 2 px `--ring`
- [ ] Options are real `<button>` or radio inputs, reachable by keyboard
- [ ] Result announced to screen readers (`aria-live="polite"`)
- [ ] Touch targets 48 px or more, options 56 px
- [ ] Works at 360 px, 768 px, 1024 px; no horizontal scroll
- [ ] Reduced motion respected
- [ ] Light theme checked (dark comes later)

## 12. Decisions (locked 2026-11-04)

| # | Decision | Boss pick |
|---|---|---|
| D1 | Student bottom tabs | 5 tabs: Home, Teachers, Practice, Saved, Me |
| D2 | Exam mode navigation | Progress bar + question-number grid |
| D3 | Right/wrong result | Same screen, under the options |
| D4 | Main colour | Indigo `#4F46E5` |
| D5 | Dark mode | Not in v1. Light only. Dark tokens kept for later |
| D6 | Language switch | One toggle in Me > Language + first sign-in, not on every screen |

## 13. Alternate look (saved, not used)

Boss saved one alternate look in the lab (favourites A, B and C are the same): main `#1D4ED8`, Hind font, 15 px text, 4 px corners, compact spacing, raised-card answers, blue/orange right/wrong (colour-blind safe). It is not part of v1. Use it only if Boss asks for an "exam hall" theme or a colour-blind setting later.

## Sources (ui-ux-pro-max searches, 2026-11-04)
- `--design-system "education exam practice quiz mobile"`: Claymorphism + Comic Neue. Rejected (made for children).
- `--design-system "adult test preparation edtech focused minimal"` (retry): Minimalism & Swiss. Style kept, palette rejected (pink).
- `--domain color "education learning trust focus"`: LMS teal, Language Learning indigo. Indigo base used.
- `--domain google-fonts "devanagari sans serif ui"`: Noto Sans Devanagari, IBM Plex Sans Devanagari, Anek Devanagari.
- `--domain typography "readable professional study"`: Lexend + Source Sans 3 (no Devanagari).
- `--domain ux`: loading indicators, confirmation messages, AI feedback loop, back button, sticky nav, mobile keyboards.
- `references/pro-rules.md`: icon, touch target and contrast rules.
