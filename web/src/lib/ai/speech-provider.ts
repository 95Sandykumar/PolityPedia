/**
 * Which voice provider the app uses (issue 43-h4-voice-providers).
 *
 * ONE VARIABLE, `VOICE_PROVIDER`, and the default is the thing that ships
 * today:
 *
 *   VOICE_PROVIDER=elevenlabs  ->  `elevenlabs-speech.ts`
 *   VOICE_PROVIDER=google      ->  `google-speech.ts`
 *   anything else, or unset    ->  `unconfigured-speech.ts`
 *
 * THE DEFAULT IS THE POINT. X5 (human ticket H4) is still open: Boss has to
 * listen to `jobs/voice-samples.ts` and pick one. Until then every install
 * falls through to the unconfigured speech, `makeExplanationAudio` stops
 * before it claims anything, and a student reads their explanation with no
 * audio bar and no error, exactly as before this file existed. An unknown word
 * also falls through, so a typo in the variable cannot half-enable a provider
 * nobody tested.
 *
 * The env is read inside `createSpeech`, not at import time, so a route that
 * imports this file still builds with no environment variables
 * (web/CLAUDE.md).
 */
import type { Speech } from './audio';
import { createElevenLabsSpeech } from './elevenlabs-speech';
import { createGoogleSpeech } from './google-speech';
import { createUnconfiguredSpeech } from './unconfigured-speech';

/** The names `VOICE_PROVIDER` accepts, lower case. */
export const VOICE_PROVIDERS = ['elevenlabs', 'google'] as const;
export type VoiceProviderName = (typeof VOICE_PROVIDERS)[number];

type EnvBag = Record<string, string | undefined>;

export interface CreateSpeechOptions {
  /** Injected by the tests and by the sample job. Never set in the app. */
  fetchImpl?: typeof fetch;
}

/**
 * The chosen provider, or null for "none".
 *
 * Trimmed and lower-cased, because this is typed by hand into a `.env.local`
 * file, and `VOICE_PROVIDER=ElevenLabs ` must not silently mean no audio.
 */
export function readVoiceProvider(env: EnvBag = process.env): VoiceProviderName | null {
  const raw = env.VOICE_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  return (VOICE_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as VoiceProviderName)
    : null;
}

export function createSpeech(
  env: EnvBag = process.env,
  options: CreateSpeechOptions = {},
): Speech {
  switch (readVoiceProvider(env)) {
    case 'elevenlabs':
      return createElevenLabsSpeech({ env, fetchImpl: options.fetchImpl });
    case 'google':
      return createGoogleSpeech({ env, fetchImpl: options.fetchImpl });
    default:
      return createUnconfiguredSpeech();
  }
}
