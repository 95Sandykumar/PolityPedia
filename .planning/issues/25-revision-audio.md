---
id: 25-revision-audio
status: blocked
type: afk
depends_on: [23-revision-screen]
---
# Revision audio: made once, saved, played with speed control

## Context
PolityPedia is a Next.js web app in `web/` for Indian Political Science exam students (UGC NET, CUET PG, TGT, PGT). Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. UI rules: `web/DESIGN.md`. Conventions: `web/CLAUDE.md` (both from issue 01). Run `npm test` and `npm run build` inside `web/`. Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests: no real network call and no real key in any test. SQL migrations live in `web/supabase/migrations/` and start with this issue's number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table. DB tests use PGlite through the helper from issue 02. Every label a user sees exists in English and Hindi through the i18n dictionary from issue 01.

## Definition of done
After an explanation is ready, an audio file is made once in the background and saved. Students press play and choose 1x, 1.25x or 1.5x.

## Vertical slice
- `Speech` interface `speak(text, lang) -> bytes` with a fake for tests. The real provider is not chosen yet (X5): ship a provider that throws 'voice not configured', so audio is simply skipped.
- After `ready`, a background step makes audio, uploads it through `FileStore`, sets `audio_path`. Never twice for the same (question, lang).
- Audio bar UI: play/pause, speed chips.

## Test that proves it
`npm test`: fake Speech is called once per (question, lang) even when 2 students open it; audio_path set; with the unconfigured provider the explanation still shows and no error reaches the student.

## Design constraints
- F-F5: made once and saved. X5 open: provider is a human ticket (H4).

## Notes / scope guard
No provider integration.

<!-- ralph 2026-11-05T18:52:21.335Z: upstream 22-revision-api blocked -->

<!-- ralph 2026-11-05T19:18:13.764Z: upstream 23-revision-screen blocked -->
