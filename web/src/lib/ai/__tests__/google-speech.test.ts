/**
 * The Google Cloud Text-to-Speech Speech, driven with a FAKE fetch
 * (issue 43-h4-voice-providers).
 *
 * Same five promises as the ElevenLabs test, plus the one thing that is
 * different about this provider: the audio arrives base64 inside JSON, so the
 * decode is part of the contract.
 *
 * No real network call and no real key anywhere here (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_DEFAULT_VOICE_EN,
  GOOGLE_DEFAULT_VOICE_HI,
  GOOGLE_ENV_KEYS,
  createGoogleSpeech,
  missingGoogleEnv,
} from '../google-speech';
import { AUDIO_CONTENT_TYPE } from '../audio';
import { VOICE_CALL_FAILED } from '../speech-errors';
import { VOICE_NOT_CONFIGURED } from '../unconfigured-speech';

const KEY = 'google-test-key-not-real';
const ENV = { GOOGLE_TTS_API_KEY: KEY };

/** Three mp3-ish bytes, base64 as the REST API returns them. */
const MP3 = new Uint8Array([0x49, 0x44, 0x33]);
const MP3_BASE64 = 'SUQz';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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
  return createGoogleSpeech({ env, fetchImpl: fetchImpl as typeof fetch });
}

function sentTo(fetchImpl: ReturnType<typeof vi.fn>, call = 0): [string, RequestInit] {
  return fetchImpl.mock.calls[call] as [string, RequestInit];
}

describe('createGoogleSpeech: configuration', () => {
  it('reads the env lazily, so importing the module needs no env', () => {
    expect(() => createGoogleSpeech()).not.toThrow();
  });

  it('is not configured with no key, and never calls out', async () => {
    const fetchImpl = vi.fn();
    const speech = speechWith(fetchImpl, {});

    expect(speech.isConfigured()).toBe(false);
    await expect(speech.speak('hello', 'en')).rejects.toThrow(VOICE_NOT_CONFIGURED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('needs only the key, because both voices have a default', () => {
    expect(speechWith(vi.fn()).isConfigured()).toBe(true);
    expect(speechWith(vi.fn()).contentType).toBe(AUDIO_CONTENT_TYPE);
    expect(GOOGLE_ENV_KEYS[0]).toBe('GOOGLE_TTS_API_KEY');
  });

  it('names the one missing variable, and nothing when it is set', () => {
    expect(missingGoogleEnv({})).toEqual(['GOOGLE_TTS_API_KEY']);
    expect(missingGoogleEnv(ENV)).toEqual([]);
  });
});

describe('createGoogleSpeech: the call', () => {
  it('decodes the base64 audio into bytes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: MP3_BASE64 }));
    const bytes = await speechWith(fetchImpl).speak('Article 80.', 'en');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Array.from(bytes)).toEqual(Array.from(MP3));
  });

  it('posts to text:synthesize with the key in the header only', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: MP3_BASE64 }));
    await speechWith(fetchImpl).speak('Article 80.', 'en');

    const [url, init] = sentTo(fetchImpl);
    expect(url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    // The documented alternative is `?key=`, which puts a secret in a URL.
    // We take the header, so a log line of the URL can never carry the key.
    expect(url).not.toContain(KEY);
    expect(url).not.toContain('key=');
    expect(String(init.body)).not.toContain(KEY);

    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('asks for the Indian English voice and MP3 for en', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: MP3_BASE64 }));
    await speechWith(fetchImpl).speak('Article 80.', 'en');

    const body = JSON.parse(String(sentTo(fetchImpl)[1].body)) as Record<string, unknown>;
    expect(body).toEqual({
      input: { text: 'Article 80.' },
      voice: { languageCode: 'en-IN', name: GOOGLE_DEFAULT_VOICE_EN },
      audioConfig: { audioEncoding: 'MP3' },
    });
  });

  it('asks for the Hindi voice for hi', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: MP3_BASE64 }));
    await speechWith(fetchImpl).speak('अनुच्छेद 80', 'hi');

    const body = JSON.parse(String(sentTo(fetchImpl)[1].body)) as Record<string, unknown>;
    expect(body.voice).toEqual({ languageCode: 'hi-IN', name: GOOGLE_DEFAULT_VOICE_HI });
  });

  it('lets the two voice variables replace the defaults', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: MP3_BASE64 }));
    await createGoogleSpeech({
      env: { ...ENV, GOOGLE_TTS_VOICE_EN: 'en-IN-Wavenet-D', GOOGLE_TTS_VOICE_HI: 'hi-IN-Wavenet-E' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).speak('Article 80.', 'hi');

    const body = JSON.parse(String(sentTo(fetchImpl)[1].body)) as Record<string, unknown>;
    expect(body.voice).toEqual({ languageCode: 'hi-IN', name: 'hi-IN-Wavenet-E' });
  });
});

describe('createGoogleSpeech: failures', () => {
  it('turns an HTTP error into the fixed message, leaking neither key nor body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { message: 'key ' + KEY + ' is not allowed' } }),
    );

    const error = await failureOf(speechWith(fetchImpl).speak('Article 80.', 'en'));

    expect(error.message).toBe(VOICE_CALL_FAILED + ' with status 403');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('not allowed');
  });

  it('treats a reply with no audio as a failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: '' }));
    await expect(speechWith(fetchImpl).speak('Article 80.', 'en')).rejects.toThrow(
      VOICE_CALL_FAILED,
    );
  });

  it('treats audio it cannot decode as a failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: 'not base64 ***' }));
    await expect(speechWith(fetchImpl).speak('Article 80.', 'en')).rejects.toThrow(
      VOICE_CALL_FAILED,
    );
  });

  it('refuses text past the documented 5000 byte input limit before it spends money', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { audioContent: MP3_BASE64 }));
    await expect(speechWith(fetchImpl).speak('x'.repeat(5_001), 'en')).rejects.toThrow(
      VOICE_CALL_FAILED,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
