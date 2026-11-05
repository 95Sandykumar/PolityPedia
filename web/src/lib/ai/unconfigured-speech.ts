/**
 * The voice provider that is not chosen yet (issue 25-revision-audio).
 *
 * X5 is an OPEN DECISION: "paid AI voice provider for Hindi + English,
 * ElevenLabs candidate, price per character unverified". Picking one is a
 * human ticket (H4), not a thing an unattended agent should decide, because
 * it spends Boss's money per character.
 *
 * So this ships instead, and the whole slice is honest about it:
 *
 *  * `isConfigured()` is false, so `makeExplanationAudio` skips the work
 *    before it claims anything. The explanation row keeps `audio_status =
 *    'none'`, so the day a provider lands, the audio is made on the next read
 *    with no backfill job.
 *  * `speak()` throws a fixed message, so a caller that ignores
 *    `isConfigured` still cannot half-write a row.
 *
 * What a student sees today: the explanation, and no audio bar. Never an
 * error, because audio is not the thing they asked for.
 *
 * When H4 is answered, this file is replaced by (say)
 * `elevenlabs-speech.ts` with the same two members, env read lazily inside
 * the call, and nothing else in the slice changes.
 */
import { AUDIO_CONTENT_TYPE, type Speech } from './audio';

/** The fixed message. Tested, so it cannot drift into something vaguer. */
export const VOICE_NOT_CONFIGURED = 'voice not configured';

export function createUnconfiguredSpeech(): Speech {
  return {
    isConfigured() {
      return false;
    },

    contentType: AUDIO_CONTENT_TYPE,

    async speak() {
      throw new Error(VOICE_NOT_CONFIGURED);
    },
  };
}
