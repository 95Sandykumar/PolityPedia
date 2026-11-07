/**
 * The second real Speech: Google Cloud Text to Speech
 * (issue 43-h4-voice-providers).
 *
 * The other candidate for open decision X5 (human ticket H4). It exists so
 * Boss can LISTEN to two voices before spending money on one of them. Like
 * the ElevenLabs file, it is dead code until `VOICE_PROVIDER=google`.
 *
 * THE DOCS THIS FILE IS BUILT FROM, read on 2026-11-06:
 *  * endpoint, request body, and the base64 `audioContent` reply:
 *    https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
 *  * the `MP3` value of `audioEncoding`:
 *    https://cloud.google.com/text-to-speech/docs/reference/rest/Shared.Types/AudioEncoding
 *  * the hi-IN and en-IN voice names:
 *    https://cloud.google.com/text-to-speech/docs/list-voices-and-types
 *  * the `x-goog-api-key` header, which is how a plain API key is passed:
 *    https://cloud.google.com/docs/authentication/api-keys-use
 *
 * THE VOICES. `hi-IN-Neural2-A` and `en-IN-Neural2-A`, both Neural2, both
 * female. Neural2 because it is the mid tier that exists for BOTH of our
 * languages (four voices each, A to D), so one tier covers the whole app.
 * Indian English, not US English, because the students are Indian and the
 * Hindi half of the same explanation is read by an Indian voice. Either can be
 * swapped with `GOOGLE_TTS_VOICE_EN` or `GOOGLE_TTS_VOICE_HI`, which is how
 * Boss tries a male voice or the newer Chirp3-HD tier without a code change.
 *
 * ONE WARNING IF BOSS SWAPS IN A CHIRP3-HD VOICE: the docs say Chirp 3 HD
 * ignores `speakingRate` and `pitch`. This file sends neither, so a swap is
 * safe; do not add them without reading that page again.
 *
 * THE KEY GOES IN A HEADER. The docs offer `?key=API_KEY` as well, and that
 * form is refused here: a URL ends up in proxy logs, error traces and `fetch`
 * failures, and this key is billable. The TTS docs themselves only document
 * OAuth, so the API key path is the generic Google one; if a key is ever
 * rejected with 401, that is the first thing to check, and the fixed error
 * message plus the status is what the caller is told.
 *
 * The env is read lazily inside every call (web/CLAUDE.md). No `console` call
 * lives in this file. A thrown error carries `VOICE_CALL_FAILED` plus the HTTP
 * status, never the response body, which quotes `error.message`.
 */
import type { Lang } from '@/lib/i18n';
import { AUDIO_CONTENT_TYPE, type Speech } from './audio';
import { VOICE_CALL_FAILED } from './speech-errors';
import { VOICE_NOT_CONFIGURED } from './unconfigured-speech';

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** BCP-47, which is what `voice.languageCode` wants. Indian both times. */
const LANGUAGE_CODE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN' };

export const GOOGLE_DEFAULT_VOICE_EN = 'en-IN-Neural2-A';
export const GOOGLE_DEFAULT_VOICE_HI = 'hi-IN-Neural2-A';

/** Which env var may replace the default voice for one language. */
const VOICE_KEY: Record<Lang, string> = {
  en: 'GOOGLE_TTS_VOICE_EN',
  hi: 'GOOGLE_TTS_VOICE_HI',
};

const DEFAULT_VOICE: Record<Lang, string> = {
  en: GOOGLE_DEFAULT_VOICE_EN,
  hi: GOOGLE_DEFAULT_VOICE_HI,
};

/**
 * "The input size is limited to 5000 bytes" (SynthesisInput docs). BYTES, not
 * characters, and Devanagari is three bytes a character in UTF-8, so a Hindi
 * explanation hits this wall at about 1,600 characters.
 *
 * Checked before the call, because a 400 after it is a round trip for nothing.
 * If this starts firing on real explanations, the fix is to split the text and
 * join the mp3s, which is a bigger slice than choosing a provider.
 */
export const GOOGLE_MAX_INPUT_BYTES = 5_000;

/** Everything Boss must set. The voices have defaults, so the key is it. */
export const GOOGLE_ENV_KEYS = ['GOOGLE_TTS_API_KEY'] as const;

type EnvBag = Record<string, string | undefined>;

export interface GoogleSpeechOptions {
  env?: EnvBag;
  fetchImpl?: typeof fetch;
}

function read(env: EnvBag, name: string): string | null {
  return env[name]?.trim() || null;
}

/** The variables that are still missing. Printed by name, never a value. */
export function missingGoogleEnv(env: EnvBag = process.env): string[] {
  return GOOGLE_ENV_KEYS.filter((name) => read(env, name) === null);
}

/**
 * base64 to bytes.
 *
 * `atob` instead of `Buffer`: it is a global in Node 18+ and in every browser,
 * so nothing here needs a Node-only import and Next.js has nothing to
 * polyfill. It THROWS on a string that is not base64, which the caller turns
 * into the one fixed failure message.
 */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createGoogleSpeech(options: GoogleSpeechOptions = {}): Speech {
  // Getters, never read here: lazy env (web/CLAUDE.md).
  const env = (): EnvBag => options.env ?? process.env;
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  return {
    /**
     * The key alone. Unlike ElevenLabs, no voice id is needed from Boss: both
     * languages have a documented default voice name in this file, so the key
     * is the only thing that can be missing.
     */
    isConfigured() {
      return missingGoogleEnv(env()).length === 0;
    },

    contentType: AUDIO_CONTENT_TYPE,

    async speak(text: string, lang: Lang): Promise<Uint8Array> {
      const bag = env();
      const apiKey = read(bag, 'GOOGLE_TTS_API_KEY');
      if (!apiKey) throw new Error(VOICE_NOT_CONFIGURED);

      if (new TextEncoder().encode(text).byteLength > GOOGLE_MAX_INPUT_BYTES) {
        throw new Error(VOICE_CALL_FAILED + ': text is longer than the API allows');
      }

      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: LANGUAGE_CODE[lang],
            name: read(bag, VOICE_KEY[lang]) ?? DEFAULT_VOICE[lang],
          },
          // No `speakingRate` and no `pitch`: the player already offers 1x,
          // 1.25x and 1.5x (DESIGN.md section 8), so speed is the student's
          // choice at play time, not a thing baked into a file made once.
          audioConfig: { audioEncoding: 'MP3' },
        }),
        cache: 'no-store',
      });

      // The body is NEVER read on a failure: `error.message` quotes the key
      // that was refused. The status is all anyone needs.
      if (!res.ok) throw new Error(VOICE_CALL_FAILED + ' with status ' + res.status);

      let audioContent: unknown = null;
      try {
        const parsed = (await res.json()) as Record<string, unknown>;
        audioContent = parsed?.audioContent;
      } catch {
        throw new Error(VOICE_CALL_FAILED + ': the reply was not readable');
      }

      if (typeof audioContent !== 'string' || audioContent.length === 0) {
        throw new Error(VOICE_CALL_FAILED + ': no audio came back');
      }

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(audioContent);
      } catch {
        throw new Error(VOICE_CALL_FAILED + ': the audio was not readable');
      }

      if (bytes.byteLength === 0) throw new Error(VOICE_CALL_FAILED + ': no audio came back');

      return bytes;
    },
  };
}
