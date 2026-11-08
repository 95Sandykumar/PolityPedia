/**
 * The ElevenLabs Speech, driven with a FAKE fetch (issue 43-h4-voice-providers).
 *
 * No real network call and no real key anywhere here (web/CLAUDE.md). What is
 * checked is what the issue pins down:
 *
 *  * bytes come back for a good response;
 *  * not configured when the key or a voice id is missing, and then it never
 *    calls out at all;
 *  * an HTTP error becomes ONE fixed short message that quotes neither the
 *    key nor the response body;
 *  * the URL, the headers and the JSON body are exactly what the ElevenLabs
 *    docs ask for, and the key travels ONLY in the `xi-api-key` header.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_ENV_KEYS,
  ELEVENLABS_OUTPUT_FORMAT,
  createElevenLabsSpeech,
  missingElevenLabsEnv,
} from '../elevenlabs-speech';
import { AUDIO_CONTENT_TYPE } from '../audio';
import { VOICE_CALL_FAILED } from '../speech-errors';
import { VOICE_NOT_CONFIGURED } from '../unconfigured-speech';

const KEY = 'xi-test-key-not-real';

const ENV = {
  ELEVENLABS_API_KEY: KEY,
  ELEVENLABS_VOICE_EN: 'voice-en-id',
  ELEVENLABS_VOICE_HI: 'voice-hi-id',
};

/** Three mp3-ish bytes. Enough to tell "something came back" from "nothing". */
const MP3 = new Uint8Array([0x49, 0x44, 0x33]);

function audioResponse(bytes: Uint8Array = MP3): Response {
  return new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': AUDIO_CONTENT_TYPE },
  });
}

/** The error a call threw. Fails loudly if the call did not throw at all. */
async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call was expected to fail and did not');
}

function speechWith(fetchImpl: unknown, env: Record<string, string> = ENV) {
  return createElevenLabsSpeech({ env, fetchImpl: fetchImpl as typeof fetch });
}

function sentTo(fetchImpl: ReturnType<typeof vi.fn>, call = 0): [string, RequestInit] {
  return fetchImpl.mock.calls[call] as [string, RequestInit];
}

describe('createElevenLabsSpeech: configuration', () => {
  it('reads the env lazily, so importing the module needs no env', () => {
    expect(() => createElevenLabsSpeech()).not.toThrow();
  });

  it('is not configured with no key, and never calls out', async () => {
    const fetchImpl = vi.fn();
    const speech = speechWith(fetchImpl, {});

    expect(speech.isConfigured()).toBe(false);
    await expect(speech.speak('hello', 'en')).rejects.toThrow(VOICE_NOT_CONFIGURED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is not configured when a voice id is missing, and never calls out', async () => {
    const fetchImpl = vi.fn();
    const speech = speechWith(fetchImpl, {
      ELEVENLABS_API_KEY: KEY,
      ELEVENLABS_VOICE_EN: 'voice-en-id',
    });

    expect(speech.isConfigured()).toBe(false);
    await expect(speech.speak('hello', 'hi')).rejects.toThrow(VOICE_NOT_CONFIGURED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is configured with the key and both voice ids', () => {
    expect(speechWith(vi.fn()).isConfigured()).toBe(true);
    expect(speechWith(vi.fn()).contentType).toBe(AUDIO_CONTENT_TYPE);
  });

  it('names every missing variable, and nothing when all are set', () => {
    expect(missingElevenLabsEnv({})).toEqual([...ELEVENLABS_ENV_KEYS]);
    expect(missingElevenLabsEnv({ ELEVENLABS_API_KEY: KEY })).toEqual([
      'ELEVENLABS_VOICE_EN',
      'ELEVENLABS_VOICE_HI',
    ]);
    expect(missingElevenLabsEnv(ENV)).toEqual([]);
  });
});

describe('createElevenLabsSpeech: the call', () => {
  it('returns the mp3 bytes of a good reply', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    const bytes = await speechWith(fetchImpl).speak('Article 80.', 'en');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Array.from(bytes)).toEqual(Array.from(MP3));
  });

  it('posts to the voice for the language, with the key in the header only', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await speechWith(fetchImpl).speak('Article 80.', 'hi');

    const [url, init] = sentTo(fetchImpl);
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-hi-id?output_format=' +
        ELEVENLABS_OUTPUT_FORMAT,
    );
    // The key is a secret: never in a URL, never in the body, only the header.
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);

    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('sends the text and the multilingual model, and nothing else', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await speechWith(fetchImpl).speak('Article 80.', 'en');

    const body = JSON.parse(String(sentTo(fetchImpl)[1].body)) as Record<string, unknown>;
    expect(body).toEqual({ text: 'Article 80.', model_id: ELEVENLABS_DEFAULT_MODEL });
  });

  it('lets ELEVENLABS_MODEL replace the default model', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await createElevenLabsSpeech({
      env: { ...ENV, ELEVENLABS_MODEL: 'eleven_flash_v2_5' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).speak('Article 80.', 'en');

    const body = JSON.parse(String(sentTo(fetchImpl)[1].body)) as Record<string, unknown>;
    expect(body.model_id).toBe('eleven_flash_v2_5');
  });
});

describe('createElevenLabsSpeech: failures', () => {
  it('turns an HTTP error into the fixed message, leaking neither key nor body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"detail":"quota for key ' + KEY + ' is gone"}', { status: 401 }),
    );

    const error = await failureOf(speechWith(fetchImpl).speak('Article 80.', 'en'));

    expect(error.message).toBe(VOICE_CALL_FAILED + ' with status 401');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('quota');
  });

  it('treats an empty reply as a failure, not as silent audio', async () => {
    const fetchImpl = vi.fn(async () => audioResponse(new Uint8Array(0)));
    await expect(speechWith(fetchImpl).speak('Article 80.', 'en')).rejects.toThrow(
      VOICE_CALL_FAILED,
    );
  });

  it('refuses text past the documented character limit before it spends money', async () => {
    const fetchImpl = vi.fn(async () => audioResponse());
    await expect(speechWith(fetchImpl).speak('x'.repeat(10_001), 'en')).rejects.toThrow(
      VOICE_CALL_FAILED,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
