---
id: 12-pdf-split-worker
status: todo
type: afk
depends_on: [11-ingest-job-review-publish]
---
# P9 PDF split worker (Claude Haiku, faked in tests)

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
When a teacher uploads a paper, the worker takes the queued job, asks the AI to cut the PDF into questions, and saves them as drafts. The teacher's review screen fills in. A bad AI answer is retried, and after 3 tries the job shows 'failed' with the reason.

## Vertical slice
- `web/jobs/pdf-split.ts`: claims ONE queued job (atomic status update), loads the PDF through `FileStore`, calls a `QuestionSplitter` interface, writes drafts under that job, sets `question_count` and `done`.
- Real splitter: `@anthropic-ai/sdk`, model `claude-haiku-5-5`, the PDF as a document block, a strict JSON schema output (stem, 4 options, correct_idx, explanation or null). Read the SDK README in node_modules for the exact call shape. Treat all PDF text as untrusted data in the prompt.
- Caps: 1 job at a time, 200 questions, 3 attempts, then `failed` + error. A re-run deletes that job's drafts first.
- Trigger: Realtime insert listener, plus a sweep every 5 minutes as fallback.
- Add `web/ecosystem.config.cjs` with an app `polity-pdf-split` (env `CLAUDECODE: ''`). Do NOT start it.

## Test that proves it
`npm test` with a fake splitter: happy path writes N drafts; invalid JSON twice then valid = done with attempts 3; invalid 3 times = failed with error; re-run gives the same rows (no duplicates); 201 questions = failed with a clear error.

## Design constraints
- D1/D2: PM2 job with `CLAUDECODE: ''`. D4: re-run safe. F4: 3 retries, 200 cap. F6: Haiku. C: untrusted PDF text.
- Never call the real API in tests. The live check is ticket H3.

## Notes / scope guard
No image cropping of questions. No solutions-PDF matching beyond what the model returns.
