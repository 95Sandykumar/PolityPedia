# PRD: PolityPedia v1

Status: draft 1, 2026-11-04. Owner: Boss.
Built from: `design.md` (v1 draft 1), `notes.md` (all decisions on 2026-11-04), `versions/v0-2026-11-04/README.md`, `research/2026-11-04-market-research.md`, the sketch `research/2026-11-04-v1-sketch.jpg`.
Architecture picture: `v1-architecture.html` (https://claude.ai/artifact/HSbKdt8sYBG5cvQBrK4LM3).

---

## 1. Summary

PolityPedia v1 is a web app for Political Science exams in India: UGC NET, CUET PG, PGT and TGT. Teachers put their past papers, paid mock tests and videos on one page. Students practise question by question. When a student gets a question wrong, they can tap Revision and an AI explains it in text and audio. This document says what v1 must do, for whom, and in what order we build it.

## 2. Contacts

| Name | Role | Comment |
|---|---|---|
| Boss | Owner, decides scope and money | Approves every release and every payment step |
| Founding teacher (name in the private file `research/2026-11-04-teacher-videos.md`) | First teacher, content partner | 50/50 share on mock set sales. Stays anonymous in public (v0 alias rule) |
| Builder agent | Builds the slices | Follows `design.md` and this PRD |
| Sentinel | QA gate | Must pass every slice before "done" |
| CA (to be named) | Tax check | Must confirm GST and marketplace tax before the first sale (X4) |

## 3. Background

- **What it is.** v0 planned a free study hub for Political Science students, with an AI tutor based on the teacher's notes. v1 turns it into a two-sided exam practice platform. Teachers bring content and students. Students pay for mock tests and for the AI.
- **Why now.** Boss drew the v1 sketch on 2026-11-04 and locked every decision the same day. The founding teacher already teaches Political Science on a large YouTube channel and wants their own space.
- **Gap in the market.** Big platforms sell by exam, not by subject. Few single teachers run their own Political Science test series (market research, 2026-11-04). Students follow a teacher, but the teacher has no place to sell tests.
- **What became possible.** Cheap AI (Claude Haiku 5.5 at $0.10 in and $0.50 out per million tokens) can read a PDF and split it into questions. It can also explain one question for about $0.022, including 2 web searches (estimate, see design.md section 2). Saving each explanation means each question costs us only once.

## 4. Objective

**Objective.** Give one teacher a paid, working exam-practice page within the first release, and get the first students paying for mock sets and the AI plan.

Why it matters:
- For students: practise with the exact papers and the teacher they trust, and understand mistakes right away.
- For teachers: a place to sell their own tests and see how their batches score.
- For PolityPedia: three income lines (mock set share, ₹100 AI plan, ₹500 Pro) on a low, known cost.
- Fit with strategy: v0 said "subject first, teacher first". v1 adds the money part without changing that.

**Key results (proposed targets. Boss confirms the numbers)**

| # | Key result | Target | When |
|---|---|---|---|
| KR1 | Daily active students | 100 | 60 days after the first public release |
| KR2 | Paid mock set sales | 50 | 60 days after payments go live |
| KR3 | AI plan or Pro subscribers | 20 | 60 days after payments go live |
| KR4 | PDF split accuracy (questions right before teacher edits) | 80% or more | Measured on the first 3 real papers |
| KR5 | AI cost per new explanation | $0.03 or less | Measured from saved token and search counts |
| KR6 | Money mismatches found by the nightly check | 0 open for more than 1 day | Every day after payments go live |

## 5. Market segments

People with a job to do, not age groups.

| Segment | The job they need done | Limits we must respect |
|---|---|---|
| UGC NET Political Science aspirants | Clear JRF or Assistant Professor cut-off (UR JRF 222/300 in June 2026). Practise past papers and full mocks | Price-aware. Cheap Android phones on 4G. Hindi and English |
| CUET PG Political Science (HUQP18) aspirants | Practise 75-question, +4/-1, 90-minute papers | Short exam season. Need timed practice |
| PGT Political Science aspirants (KVS, NVS, DSSSB, state) | Practise state and central papers that come out on irregular dates | Many exam bodies. Each teacher keeps their own next exam date |
| TGT aspirants | Practise the Political Science part of a Social Science paper | Lower willingness to pay |
| Teachers (starting with the founding teacher) | Sell their own tests. Keep students in one place. See batch scores | Little time. Content is in PDFs. Must stay anonymous if they want |

## 6. Value propositions

| Customer job | What they gain | Pain they avoid | Why we do it better |
|---|---|---|---|
| Practise real past papers | Free, one question per screen, Reveal answer, the teacher's own explanation | Scrolling a PDF with the answers far away | Big apps sell by exam. We give the subject and the teacher |
| Practise full mocks | Practice mode and timed exam mode, topic-wise or full paper | Paying ₹1,299 to ₹1,999 for a series (JRFAdda, unverified) | ₹299 to ₹399 a set, made by a teacher they know |
| Understand a mistake | AI explanation in text and audio, with sources, for ₹100 a month | Waiting for a doubt class | Instant, and in Hindi or English |
| Teacher sells tests | Set price inside a band, batch access, scores per batch | Building their own app (AppX white-label) | No setup cost. A share of every sale |

**Value curve (compared with big test-series apps):** lower price, same or better question quality (the teacher's own), much stronger teacher connection, instant explanations, fewer exams covered (only Political Science).

## 7. Solution

### 7.1 UX (screens, plain wireframes)

```
TEACHER PORTFOLIO (student view)        MOCK TEST LIST
+------------------------------+        +------------------------------+
| [photo or alias]  Teacher    |        | UGC NET Mock Set (₹399)      |
| Next exam: NET 18 Dec        |        | Test 1   64/200  ✓  [Review] |
| [Videos] [Past papers]       |        | Test 2   44/200  ✓  [Review] |
| [Mock tests] [Notifications] |        | Test 3            [Attempt]  |
| [ Follow ]                   |        | Topic: [Full paper ▼]        |
+------------------------------+        | Mode:  (Practice) (Exam)     |
                                        +------------------------------+
QUESTION PLAYER                          WRONG ANSWER
+------------------------------+        +------------------------------+
| UGC NET 2025 · Dec           |        | ✗ Wrong. Right answer: C     |
| [=====>------------] 12/100  |        | [Teacher explanation ▼]      |
| Q. ......................... |        | [ Revision (AI) ]            |
| (a) ...  (b) ...             |        | [ Mark for later ]  [ Next ] |
| (c) ...  (d) ...             |        +------------------------------+
| [Reveal answer] [Mark later] |        RIGHT ANSWER: ✓ Correct, [Mark for later] [Next]
+------------------------------+
REVISION (AI)                            TEACHER: PRICE A SET
+------------------------------+        +------------------------------+
| Exam · Topic · Question      |        | Set name ............        |
| Explanation (sections)       |        | Exam [UGC NET ▼]             |
| Sources: link, link          |        | Price ₹[299 ... 399]         |
| [▶ Listen]                   |        | Tests in set: 15             |
| Not on the AI plan? -> ₹100  |        | Free sample: Test 1 [x]      |
+------------------------------+        | Batches with free access [ ] |
                                        +------------------------------+
```

Main flows:
1. Student: sign in > pick exam > follow teacher > open portfolio > past papers or mock tests > player > right or wrong > Revision.
2. Teacher: sign in > upload past paper PDF > wait for the split > check each question next to its PDF page > publish.
3. Teacher: create a mock set > add tests and questions > set price > publish > share the batch join link.
4. Buy: tap a locked set > Razorpay checkout > set opens.

### 7.2 Key features

IDs match `design.md` (V1 to V19). Each line is a must for v1 unless it says V2.

**A. Accounts and teachers**
- F-A1 Two roles: teacher and student. Teacher signup is by invite only, and an admin approves it (v0).
- F-A2 Student picks one or more exams and follows teachers. The button is called **Follow** and is free. Followers get the teacher's notifications.
- F-A3 Teacher portfolio with 4 tiles: Videos, Past papers, Mock tests, Notifications.
- F-A4 Each teacher keeps the next exam date for each of their exams.
- F-A5 The alias mode from v0 stays. A student never sees the real name of a teacher in alias mode.

**B. Batches**
- F-B1 Teacher creates many batches. A student can be in many batches.
- F-B2 Student joins by link or code. Teacher can remove a student.
- F-B3 Teacher picks which mock sets a batch gets for free.
- F-B4 Teacher sees batch scores (per test and per student) on their own tests only.

**C. Videos**
- F-C1 Teacher pastes YouTube links only. We show the thumbnail and title.
- F-C2 Teacher switch: Show or No show. No show = "Coming soon".

**D. Past papers (free)**
- F-D1 Structure: Exam > Year > Month (optional) > PDF (questions, solutions or both). Each teacher keeps their own copy and their own explanations. Only that teacher can edit.
- F-D2 AI splits the PDF into questions (stem, 4 options, answer, explanation). Limit: 30 MB and 200 questions per PDF.
- F-D3 Teacher review screen: each question next to its PDF page. Edit, then publish. Nothing goes live before publish.
- F-D4 Player: exam on top, progress bar (question i of N), Reveal answer, Mark for later. The PDF can still be downloaded.

**E. Mock tests (paid)**
- F-E1 Teacher creates sets. A set holds tests. Price is ₹299 to ₹399 per set, chosen by the teacher. Test 1 can be a free sample.
- F-E2 Mock list: taken tests show a tick and the score. The Attempt button starts a test.
- F-E3 Student chooses full paper or one topic.
- F-E4 Practice mode: right or wrong after each question.
- F-E5 Exam mode: timer, no answers shown until the end, score at the end. The answer key never reaches the phone before submit.
- F-E6 Marking per exam from the `exams` table (CUET PG +4/-1, 90 min; UGC NET +2/0, unverified).
- F-E7 Wrong screen: right answer, teacher explanation (dropdown), Revision, Mark for later, Next. Right screen: Correct, Mark for later, Next.
- F-E8 One "Saved" list with two tags: Wrong and Marked.

**F. AI revision**
- F-F1 Only for students on the AI plan (₹100 a month) or Pro (₹500 a month).
- F-F2 AI input: exam, topic, question, options, right answer, teacher explanation, plus up to 2 web searches. Model: Claude Haiku 5.5.
- F-F3 Output follows the sketch format: Exam, Topic, Question, explanation sections, sources.
- F-F4 One explanation per question and language, saved and reused by all students. The teacher can edit it.
- F-F5 Audio: a paid AI voice, Hindi and English, made once and saved.
- F-F6 Limit: 30 new explanations per student per day (India time). Saved ones are free and unlimited.
- F-F7 If two students ask for the same new question at once, only one AI call runs. The second student waits for the result.

**G. Money**
- F-G1 Three products: mock sets (one-time payment), AI plan ₹100 a month, Pro ₹500 a month (AI, notes and score vs cut-off, as in v0).
- F-G2 Razorpay: Orders for sets, Subscriptions for the plans. The price always comes from our database, never from the phone.
- F-G3 Webhook: check the signature first, store each event once, and move status forward only.
- F-G4 Teacher share is a setting per teacher (founding teacher: 50%). It applies to mock set sales only. The share is copied onto each sale, so changing it later does not change past sales.
- F-G5 Ledger row per sale: gross, GST, gateway fee, net, teacher amount, platform amount.
- F-G6 Nightly check compares Razorpay with our database and alerts Boss on any mismatch.
- F-G7 Payout: monthly bank transfer from the ledger report (X1 default). Razorpay Route in V2.

**H. Notifications**
- F-H1 Teacher posts (priority, heading, link) show at the top. The nightly news from v0 shows below them.
- F-H2 Image + heading posts: V2.

### 7.3 Technology (short; full detail in design.md)
- Next.js on its own Vercel account (Mumbai region `bom1`). **Vercel Pro is required before the first sale** (Hobby is non-commercial).
- Supabase in Mumbai: Auth, Postgres with RLS on every table, Storage, Realtime.
- Claude Haiku 5.5 for PDF split and AI revision. Web search capped at 2 per explanation.
- Laptop PM2 jobs: P9 PDF split, P10 ledger and reconcile (plus the v0 jobs).
- Answers go from the browser straight to Supabase, so they do not use Vercel requests.

### 7.4 Assumptions (not proven yet)

| # | Assumption | How we check it |
|---|---|---|
| AS1 | ₹299 to ₹399 per set sells when a set has 10 to 15 full mocks | First 30 days of sales. Competitor prices are unverified search snippets |
| AS2 | AI splits a PDF with 80% or more of questions right | Run it on 3 real papers from the founding teacher |
| AS3 | One new explanation costs about $0.022 | One real API call. Read the token and search counts |
| AS4 | 30 new explanations a day is enough for a student | Watch how often students hit the limit in the first month |
| AS5 | UGC NET marking is +2 with no negative marking | Check the NTA notice |
| AS6 | Razorpay fee is about 2% and GST is 18% inside the price | Razorpay pricing page and the CA (X4) |
| AS7 | A second free Vercel account is allowed (v0) | Moot once we move to Vercel Pro for payments |

Open decisions with defaults (from design.md X1 to X8): payout method, how long a set stays open (default: teacher's next exam date + 30 days, else 12 months), share on net (default), GST and marketplace tax (CA), voice provider (ElevenLabs candidate, untested), same AI limit for Pro (default yes), web search version on Haiku 5.5 (test call), Adda247 contract check.

## 8. Release

Each slice ships on its own and passes Sentinel before the next one starts. Times are rough and assume one builder.

| Slice | What ships | Rough size | Gate before it starts |
|---|---|---|---|
| S1 Foundation | Roles, teacher invite and approval, exams, student exam pick, Follow, portfolio with 4 tiles, next exam date, videos tile with Show / No show | 1 to 2 weeks | None |
| S2 Past papers | PDF upload, AI split (P9), teacher review and publish, question player, Reveal answer, Saved list | 1 to 2 weeks | AS2 test on 1 real paper |
| S3 Mock tests | Sets, tests, topics, Practice and Exam modes, scores, ticks, batches with join links and free access, batch reports. **No payments yet.** Access is given by batch or admin | 2 weeks | S2 done |
| S4 AI revision | Revision button, Haiku + web search, saved explanations, teacher edit, daily limit, then audio. Plans given by admin for testing | 1 to 2 weeks | AS3 measured, X5 voice picked, X7 tested |
| S5 Money | Vercel Pro, Razorpay Orders and Subscriptions, webhook, ledger, nightly check, payout report, teacher pricing screen | 2 weeks | X1, X3, X4, X8 cleared by Boss and the CA |
| Launch | Public release to the founding teacher's students | after S5 | Sentinel pass on all slices, Reality Checker re-runs the design.md check table |

**v1 includes:** everything in section 7.2 except the lines marked V2.

**V2 later:** Razorpay Route auto payouts, image notifications, Instagram feed (v0), AI follow-up chat on a question, more subjects.

**v0 features still planned** (from v0 design, not repeated here): news, community groups, AI tutor over notes, weekly newsletter, Google Sheet copy. They keep their v0 spec and slot in after S5 unless Boss moves them.
