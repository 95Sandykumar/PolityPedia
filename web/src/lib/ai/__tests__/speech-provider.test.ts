/**
 * Which voice provider the app uses (issue 43-h4-voice-providers).
 *
 * The point of this test is the DEFAULT. X5 is still open, so with no
 * `VOICE_PROVIDER` set, and with a word nobody recognises, the app must get
 * the SAME unconfigured speech it has today: audio is skipped, the
 * explanation still shows, nothing is claimed and no key is needed. Students
 * see no change until Boss sets that one variable.
 */
import { describe, expect, it, vi } from 'vitest';
import { AUDIO_CONTENT_TYPE } from '../audio';
import { VOICE_PROVIDERS, createSpeech, readVoiceProvider } from '../speech-provider';
import { VOICE_NOT_CONFIGURED } from '../unconfigured-speech';

const ELEVEN = {
  ELEVENLABS_API_KEY: 'xi-test-key-not-real',
  ELEVENLABS_VOICE_EN: 'voice-en-id',
  ELEVENLABS_VOICE_HI: 'voice-hi-id',
};
const GOOGLE = { GOOGLE_TTS_API_KEY: 'google-test-key-not-real' };
/** Both providers' env at once, so only VOICE_PROVIDER can decide. */
const BOTH = { ...ELEVEN, ...GOOGLE };

const MP3_BASE64 = 'SUQz';

function fakeFetch() {
  return vi.fn(async (url: string) =>
    String(url).includes('texttospeech')
      ? new Response(JSON.stringify({ audioContent: MP3_BASE64 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          status: 200,
          headers: { 'content-type': AUDIO_CONTENT_TYPE },
        }),
  );
}

/** Which host the chosen provider talked to. The only honest proof. */
async function hostCalled(env: Record<string, string>): Promise<string> {
  const fetchImpl = fakeFetch();
  await createSpeech(env, { fetchImpl: fetchImpl as unknown as typeof fetch }).speak('hi', 'en');
  return new URL(String((fetchImpl.mock.calls[0] as [string])[0])).host;
}

describe('readVoiceProvider', () => {
  it('reads the two names we support, trimmed and in any case', () => {
    expect(readVoiceProvider({ VOICE_PROVIDER: 'elevenlabs' })).toBe('elevenlabs');
    expect(readVoiceProvider({ VOICE_PROVIDER: '  ElevenLabs  ' })).toBe('elevenlabs');
    expect(readVoiceProvider({ VOICE_PROVIDER: 'GOOGLE' })).toBe('google');
    expect(VOICE_PROVIDERS).toEqual(['elevenlabs', 'google']);
  });

  it('reads anything else, and nothing at all, as no provider', () => {
    expect(readVoiceProvider({})).toBeNull();
    expect(readVoiceProvider({ VOICE_PROVIDER: '' })).toBeNull();
    expect(readVoiceProvider({ VOICE_PROVIDER: 'openai' })).toBeNull();
  });
});

describe('createSpeech', () => {
  it('reads the env lazily, so importing the module needs no env', () => {
    expect(() => createSpeech()).not.toThrow();
  });

  it('gives the unconfigured speech when VOICE_PROVIDER is unset', async () => {
    const speech = createSpeech(BOTH);
    expect(speech.isConfigured()).toBe(false);
    await expect(speech.speak('hi', 'en')).rejects.toThrow(VOICE_NOT_CONFIGURED);
  });

  it('gives the unconfigured speech for a name it does not know', async () => {
    const speech = createSpeech({ ...BOTH, VOICE_PROVIDER: 'polly' });
    expect(speech.isConfigured()).toBe(false);
    await expect(speech.speak('hi', 'en')).rejects.toThrow(VOICE_NOT_CONFIGURED);
  });

  it('gives ElevenLabs for elevenlabs', async () => {
    expect(createSpeech({ ...BOTH, VOICE_PROVIDER: 'elevenlabs' }).isConfigured()).toBe(true);
    expect(await hostCalled({ ...BOTH, VOICE_PROVIDER: 'elevenlabs' })).toBe('api.elevenlabs.io');
  });

  it('gives Google for google', async () => {
    expect(createSpeech({ ...BOTH, VOICE_PROVIDER: 'google' }).isConfigured()).toBe(true);
    expect(await hostCalled({ ...BOTH, VOICE_PROVIDER: 'google' })).toBe(
      'texttospeech.googleapis.com',
    );
  });

  it('is still not configured when the provider is named but its key is not set', () => {
    expect(createSpeech({ VOICE_PROVIDER: 'elevenlabs' }).isConfigured()).toBe(false);
    expect(createSpeech({ VOICE_PROVIDER: 'google' }).isConfigured()).toBe(false);
  });

  it('always says mp3, whichever provider it picked', () => {
    for (const env of [{}, { VOICE_PROVIDER: 'elevenlabs' }, { VOICE_PROVIDER: 'google' }]) {
      expect(createSpeech(env).contentType).toBe(AUDIO_CONTENT_TYPE);
    }
  });
});
