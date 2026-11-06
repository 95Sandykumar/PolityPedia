/**
 * The background step that makes one explanation's audio
 * (issue 25-revision-audio).
 *
 * Definition of done: "After an explanation is ready, an audio file is made
 * once in the background and saved."
 *
 * The order of the steps is the design:
 *
 *   1. configured?  -- no voice provider (X5) or no Supabase: stop BEFORE
 *                      claiming anything, so the row stays claimable for the
 *                      day a provider is picked. No backfill job needed.
 *   2. claimAudio() -- ONE transaction in Postgres decides who pays for the
 *                      voice call. This file never decides it.
 *   3. the voice    -- only on `claimed`, and exactly once.
 *   4. upload       -- through `FileStore`, to a path derived from
 *                      (question, language), so a retry overwrites nothing.
 *   5. finishAudio()-- point the row at the object.
 *
 * NOTHING HERE EVER THROWS. That is the second half of the issue's test:
 * "with the unconfigured provider the explanation still shows and no error
 * reaches the student". Audio is a bonus on a screen the student opened to
 * READ something. A broken voice call must cost them nothing, not even an
 * error line, so every failure path ends in a released row and a returned
 * code.
 *
 * Nothing here reads `process.env` or calls `fetch`: both outside services
 * arrive as arguments.
 */
import type { FileStore } from '@/lib/papers/types';
import {
  explanationAudioPath,
  explanationSpeechText,
  type ExplanationAudioClient,
  type Speech,
} from './audio';
import type { ExplanationBody, RevisionRequest } from './types';

/** What the step did. Returned, never thrown. */
export type AudioOutcome =
  /** Made, uploaded and saved. */
  | 'made'
  /** No voice provider (X5) or no Supabase. Skipped, nothing claimed. */
  | 'not_configured'
  /** Already saved by somebody else's call. Nothing to do. */
  | 'ready'
  /** Somebody else's voice call is in flight. Nothing to do. */
  | 'making'
  /** The explanation text is not finished yet. */
  | 'not_ready'
  /** No such explanation, or the question is not readable. */
  | 'not_found'
  /** Something broke. The row was released, so a later read may retry. */
  | 'failed';

export interface MakeAudioInput {
  request: RevisionRequest;
  /** The finished text. The caller already has it, so it is not re-read. */
  body: ExplanationBody;
  audio: ExplanationAudioClient;
  speech: Speech;
  store: FileStore;
}

export async function makeExplanationAudio({
  request,
  body,
  audio,
  speech,
  store,
}: MakeAudioInput): Promise<AudioOutcome> {
  // Step 1. Checked before the claim, so an unconfigured install leaves the
  // database exactly as it was.
  if (!speech.isConfigured()) return 'not_configured';
  if (!audio.isConfigured()) return 'not_configured';
  if (!store.isConfigured()) return 'not_configured';

  const text = explanationSpeechText(body);
  if (text.trim().length === 0) return 'not_ready';

  // Step 2. The gate. A thrown error here means nothing was claimed, so
  // there is nothing to release.
  // `claimed.secret` is the one-time secret for this voice claim, and this
  // local variable is the ONLY place it lives (issue 37-ai-claim-secret). It
  // goes to `finishAudio` and to `failAudio`, and nowhere else. The step
  // returns a word, never the secret, so there is no path from here to the
  // student's browser.
  let claimed: Awaited<ReturnType<ExplanationAudioClient['claimAudio']>>;
  try {
    claimed = await audio.claimAudio(request);
  } catch {
    return 'failed';
  }

  if (claimed.code !== 'claimed') return claimed.code;

  // From here on the row says `making` and belongs to us, so EVERY exit has
  // to either save it or release it, and both need the secret.
  try {
    const bytes = await speech.speak(text, request.lang);
    if (bytes.byteLength === 0) throw new Error('voice returned no bytes');

    const path = explanationAudioPath(request.questionId, request.lang);
    await store.upload({ path, contentType: speech.contentType, bytes });

    const saved = await audio.finishAudio(request, path, claimed.secret);
    // False means the row moved under us (a teacher edit, a takeover, or the
    // row is gone). The object is harmless: the path is derived, so the next
    // attempt writes the same one.
    if (!saved) throw new Error('audio path saved nothing');

    return 'made';
  } catch {
    await giveBack(audio, request, claimed.secret);
    return 'failed';
  }
}

/** Never let the release itself throw: that would hide the real failure. */
async function giveBack(
  audio: ExplanationAudioClient,
  request: RevisionRequest,
  secret: string | null,
): Promise<void> {
  try {
    await audio.failAudio(request, secret);
  } catch {
    // Nothing useful to do. The row stays `making` and this explanation has
    // no audio. The student still has the text, which is what they came for.
  }
}
