/**
 * The first real Speech: ElevenLabs text to speech (issue 43-h4-voice-providers).
 *
 * This is one of the TWO candidates for open decision X5 (human ticket H4).
 * It is NOT switched on by picking it here: `speech-provider.ts` only returns
 * it when `VOICE_PROVIDER=elevenlabs`, so a student sees exactly what they see
 * today until Boss has listened to the samples and set that variable.
 *
 * THE DOCS THIS FILE IS BUILT FROM, read on 2026-11-06:
 *  * endpoint, `output_format`, the `xi-api-key` header and the body fields:
 *    https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 *  * the model list and which models speak Hindi:
 *    https://elevenlabs.io/docs/models
 *
 * THE MODEL. `eleven_multilingual_v2`, which is also the API's own default for
 * this endpoint. It is picked for three documented reasons: its language list
 * contains `hi` (Hindi); the model guide's "Quality" row recommends it for
 * high fidelity output; and its 10,000 character limit covers a whole
 * explanation in one call. `eleven_flash_v2_5` also speaks Hindi and is
 * documented as "50% lower price per character", so it is the obvious cheaper
 * swap: set `ELEVENLABS_MODEL=eleven_flash_v2_5` and nothing else changes.
 *
 * `language_code` is deliberately NOT sent. The docs say it "is not supported
 * for multilingual_v2 models", and the language is already decided by WHICH
 * VOICE we post to, which is the per-language env var.
 *
 * The env is read lazily inside every call, so importing this file can never
 * break `npm run build` or `npm test` with no environment variables
 * (web/CLAUDE.md).
 *
 * Security. The key spends Boss's money per character, so: it goes in a
 * header, never in the URL and never in the body; no `console` call lives in
 * this file; and a thrown error carries `VOICE_CALL_FAILED` plus the HTTP
 * status, never the response body.
 */
import type { Lang } from '@/lib/i18n';
import { AUDIO_CONTENT_TYPE, type Speech } from './audio';
import { VOICE_CALL_FAILED } from './speech-errors';
import { VOICE_NOT_CONFIGURED } from './unconfigured-speech';

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech/';

/**
 * mp3, 44.1 kHz, 128 kbps: the endpoint's own default, and the one mp3 option
 * the docs do NOT gate behind a paid tier (192 kbps needs Creator or above).
 * The app stores `audio/mpeg` (`AUDIO_CONTENT_TYPE`), so mp3 is not optional.
 */
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

/** See the header comment for why this one. Override with `ELEVENLABS_MODEL`. */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * The documented per-request text limit for `eleven_multilingual_v2`.
 *
 * Checked BEFORE the call on purpose: a refusal after the request is a billed
 * call that returns nothing.
 */
export const ELEVENLABS_MAX_CHARS = 10_000;

/** Everything Boss must set. Printed by name when one is missing. */
export const ELEVENLABS_ENV_KEYS = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_EN',
  'ELEVENLABS_VOICE_HI',
] as const;

type EnvBag = Record<string, string | undefined>;

export interface ElevenLabsSpeechOptions {
  env?: EnvBag;
  fetchImpl?: typeof fetch;
}

/** Which env var holds the voice for one language. */
const VOICE_KEY: Record<Lang, string> = {
  en: 'ELEVENLABS_VOICE_EN',
  hi: 'ELEVENLABS_VOICE_HI',
};

function read(env: EnvBag, name: string): string | null {
  return env[name]?.trim() || null;
}

/**
 * The variables that are still missing, in the order Boss should set them.
 *
 * Used by `jobs/voice-samples.ts` to tell Boss exactly what to add to
 * `web/.env.local`, instead of a bare "not configured".
 */
export function missingElevenLabsEnv(env: EnvBag = process.env): string[] {
  return ELEVENLABS_ENV_KEYS.filter((name) => read(env, name) === null);
}

export function createElevenLabsSpeech(options: ElevenLabsSpeechOptions = {}): Speech {
  // Getters, never read here: lazy env (web/CLAUDE.md).
  const env = (): EnvBag => options.env ?? process.env;
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  return {
    /**
     * The key AND both voice ids.
     *
     * Why both, when one call only needs one: `Speech.isConfigured()` takes no
     * language (that interface is `audio.ts`, shared with the claim logic),
     * and `makeExplanationAudio` asks it BEFORE it claims the row. If half a
     * setup counted as configured, a Hindi explanation would claim the slot,
     * then fail on the missing Hindi voice, and that claim is a real cost. All
     * or nothing is the cheap direction.
     */
    isConfigured() {
      return missingElevenLabsEnv(env()).length === 0;
    },

    contentType: AUDIO_CONTENT_TYPE,

    async speak(text: string, lang: Lang): Promise<Uint8Array> {
      const bag = env();
      const apiKey = read(bag, 'ELEVENLABS_API_KEY');
      const voiceId = read(bag, VOICE_KEY[lang]);
      // Re-checked here, with the language in hand, so the voice id for the
      // language we were actually asked for is the one that must exist.
      if (!apiKey || !voiceId) throw new Error(VOICE_NOT_CONFIGURED);

      if (text.length > ELEVENLABS_MAX_CHARS) {
        throw new Error(VOICE_CALL_FAILED + ': text is longer than the model allows');
      }

      const url =
        ENDPOINT +
        encodeURIComponent(voiceId) +
        '?output_format=' +
        ELEVENLABS_OUTPUT_FORMAT;

      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'content-type': 'application/json',
          accept: AUDIO_CONTENT_TYPE,
        },
        body: JSON.stringify({ text, model_id: read(bag, 'ELEVENLABS_MODEL') ?? ELEVENLABS_DEFAULT_MODEL }),
        cache: 'no-store',
      });

      // The body is NEVER read on a failure: it can quote the key and the
      // account. The status is all a caller needs, and all a log may hold.
      if (!res.ok) throw new Error(VOICE_CALL_FAILED + ' with status ' + res.status);

      const bytes = new Uint8Array(await res.arrayBuffer());
      // Zero bytes would upload as a playable-looking file that plays
      // nothing, and the row would be saved as `ready` forever (F-F5).
      if (bytes.byteLength === 0) throw new Error(VOICE_CALL_FAILED + ': no audio came back');

      return bytes;
    },
  };
}
