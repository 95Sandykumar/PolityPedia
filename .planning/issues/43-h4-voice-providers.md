---
id: 43-h4-voice-providers
status: todo
type: afk
depends_on: []
---
# Tools for H4: voice providers behind the existing Speech interface, and a sample maker

## Context
PolityPedia is a Next.js web app in `web/`. Specs: `PRD-PolityPedia-v1.md` and `design.md` at the repo root. Conventions: `web/CLAUDE.md`. Run tools from inside `web/`. Every outside service is behind a small interface and is faked in tests: no real network call, no real key in any test. Env is read lazily inside functions, never at import time.

Open decision X5 (human ticket H4, `.planning/issues/H4-voice-provider.md`): which paid voice provider speaks the revision explanations in Hindi and English. Boss wants to LISTEN to samples from more than one provider before choosing. Today `src/lib/ai/unconfigured-speech.ts` is the placeholder; its header says a real file replaces it with the same two members (`isConfigured()` and `speak()`). The interface is `Speech` in `src/lib/ai/audio.ts`, audio is stored by `src/lib/ai/explanation-audio.ts`, and `src/lib/ai/memory-speech.ts` is the test fake. Read those first.

## What to build
1. `src/lib/ai/elevenlabs-speech.ts`: a `Speech` implementation over the ElevenLabs text-to-speech REST API. Env (read lazily inside the call): `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_EN`, `ELEVENLABS_VOICE_HI`, optional `ELEVENLABS_MODEL` (default a multilingual model; check the ElevenLabs docs for the current Hindi-capable model id and write the id you chose and the doc URL in a comment). `isConfigured()` is true only when the key and the voice id for the requested language exist. Returns MP3 bytes (the app stores `audio/mpeg`, see `AUDIO_CONTENT_TYPE`). Errors: a fixed short message, never the key, never the response body verbatim.
2. `src/lib/ai/google-speech.ts`: a second `Speech` implementation over Google Cloud Text-to-Speech REST (`text:synthesize`), env `GOOGLE_TTS_API_KEY`, optional `GOOGLE_TTS_VOICE_EN` and `GOOGLE_TTS_VOICE_HI` with sensible defaults (look up current Hindi and Indian English neural voice names in the Google docs and cite the URL in a comment), MP3 output. Same rules.
3. `src/lib/ai/speech-provider.ts`: `createSpeech(env)` chooses the provider from `VOICE_PROVIDER` (`elevenlabs`, `google`, anything else or unset means the existing unconfigured speech), so nothing changes for students until Boss sets that variable. Find where `createUnconfiguredSpeech` is used today (routes and the revision audio flow) and switch those call sites to `createSpeech(process.env)` read lazily; behaviour with no env must be exactly as now (the existing tests prove it).
4. `jobs/voice-samples.ts` (run with `node --import ./jobs/register-alias.mjs jobs/voice-samples.ts [--text-en "..."] [--text-hi "..."]`): for each provider that `isConfigured()`, make one English and one Hindi sample from built-in realistic sample texts (a 60 to 90 word explanation of a polity question in each language, written by you, Devanagari for Hindi, no em or en dashes) or from `--text-en` and `--text-hi`, save the MP3s as `web/live-checks/voice-samples/<provider>-<lang>.mp3` (folder gitignored except `.gitkeep`), and print for each: characters sent, an estimated price using a small `jobs/voice-prices.ts` table (per 1000 characters, each value commented "UNVERIFIED, check the provider's pricing page" with the date), and the file path. If no provider is configured, print which env variables to set for each and exit 0.
5. `jobs/voice-samples.README.md`: exactly what Boss does: create the two API keys, add them to `web/.env.local`, run the command, listen, pick one, set `VOICE_PROVIDER`.

## Test that proves it
Unit tests with fake fetch, no network: each provider returns bytes for a good response, reports not configured when its env is missing, maps an HTTP error to the fixed message without leaking the key or body, and sends the expected URL, headers and JSON (assert the key travels only in the header or query the provider requires, never logged); `createSpeech` returns the unconfigured speech for unset and unknown `VOICE_PROVIDER` and the right provider for each value; the existing audio and revision tests still pass unchanged; the sample script's price maths is checked with known character counts. `npm test`, `npm run typecheck`, `npm run build` pass.

## Notes / scope guard
Do not edit `package.json`, `i18n.ts`, any migration, or the audio claim and finish logic (0038 and 0040 own it: only the server finishes a claim, already done). Never print or log a key. Do not call a real provider in any test.
