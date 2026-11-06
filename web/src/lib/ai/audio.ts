/**
 * The Revision audio contract (issue 25-revision-audio).
 *
 * F-F5, the rule the whole slice exists for: the audio for one explanation is
 * MADE ONCE and saved, then every student plays the same file. A paid voice
 * is charged per character, so a second call for the same words is money
 * spent on nothing.
 *
 * Both outside services sit behind an interface, so the tests fake them: no
 * real network call, no real key, no real voice provider anywhere in the
 * suite (web/CLAUDE.md).
 *
 *  * `Speech`                 -- the voice. Faked in every test. The REAL
 *                                provider is not chosen yet (X5, human
 *                                ticket H4), so `unconfigured-speech.ts`
 *                                ships instead and audio is simply skipped.
 *  * `ExplanationAudioClient` -- server side, carries the student's own
 *                                access token, so the SQL in
 *                                `0025_revision_audio.sql` is the real gate.
 *  * `FileStore`              -- Supabase Storage, the same interface issue
 *                                10 wrote for paper PDFs.
 *
 * Nothing here reads `process.env` or calls `fetch`, so importing this file
 * can never break a build that has no environment variables.
 */
import type { Lang } from '@/lib/i18n';
import { readClaimSecret } from './types';
import type { ExplanationBody, RevisionRequest } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The private Storage bucket the audio lives in.
 *
 * Its own bucket, not the papers one: a paper PDF is read by its teacher's
 * students, an explanation audio by everybody, so the two want different
 * storage policies. Buckets are made in the Supabase dashboard, like
 * `papers`.
 */
export const AUDIO_BUCKET = 'explanation-audio';

/** mp3: every browser on a cheap Android phone plays it (DESIGN.md D1). */
export const AUDIO_CONTENT_TYPE = 'audio/mpeg';
export const AUDIO_EXTENSION = 'mp3';

/** How long a play URL lives. Long enough for one listen, not for sharing. */
export const AUDIO_URL_SECONDS = 60 * 60;

/** DESIGN.md section 8: "1x / 1.25x / 1.5x speed", in that order. */
export const AUDIO_SPEEDS: readonly number[] = [1, 1.25, 1.5];
export const DEFAULT_AUDIO_SPEED = 1;

// --------------------------------------------------------------------------
// The voice
// --------------------------------------------------------------------------

/**
 * The voice provider, behind one method.
 *
 * `speak(text, lang) -> bytes`, exactly as the issue words it. `contentType`
 * sits beside it because the upload needs a MIME type and a provider knows
 * its own format; it is a property, not a second method, so a fake is three
 * lines.
 */
export interface Speech {
  /** False when the voice key is missing, so the step can skip the work. */
  isConfigured(): boolean;
  /** The MIME type of everything `speak` returns. */
  readonly contentType: string;
  /**
   * One explanation read out in one language.
   *
   * Throws when the provider is not set up or the call fails. The caller
   * (`makeExplanationAudio`) turns that into a released row, never into
   * something a student sees.
   */
  speak(text: string, lang: Lang): Promise<Uint8Array>;
}

// --------------------------------------------------------------------------
// The one word the database answers with
// --------------------------------------------------------------------------

/**
 * What `claim_explanation_audio()` returns. The step does what it says and
 * decides nothing itself, because the decision has to be one transaction.
 */
export type AudioClaimCode =
  /** No such explanation, or the question is not readable. */
  | 'not_found'
  /** The TEXT is still being written. Nothing to read out yet. */
  | 'not_ready'
  /** Saved already. Costs nothing; do nothing. */
  | 'ready'
  /** Somebody else's voice call is in flight. Costs nothing; do nothing. */
  | 'making'
  /** You won the race: call the voice, then `finishAudio`. */
  | 'claimed';

const AUDIO_CLAIM_CODES: readonly AudioClaimCode[] = [
  'not_found',
  'not_ready',
  'ready',
  'making',
  'claimed',
];

export function isAudioClaimCode(value: unknown): value is AudioClaimCode {
  return typeof value === 'string' && (AUDIO_CLAIM_CODES as readonly string[]).includes(value);
}

/**
 * What `claim_explanation_audio()` now answers with (issue
 * 37-ai-claim-secret): the word, plus the one-time secret on `claimed`.
 *
 * The same rule as the text claim, for the same reason. Releasing a voice
 * call that is still running makes the next read pay for a second one, and
 * a paid voice is billed per character, so `auth.uid()` alone was not a gate
 * against the claimant's own browser.
 */
export interface AudioClaimOutcome {
  code: AudioClaimCode;
  /** Set on `claimed` and nothing else. Never leaves the server. */
  secret: string | null;
}

/**
 * Read the RPC reply into an `AudioClaimOutcome`.
 *
 * An unknown word reads as `making`: the fail-closed answer, because it is
 * the one code that makes the caller do nothing at all. It must never read as
 * `claimed`. A secret on any other word is dropped.
 */
export function readAudioClaimOutcome(value: unknown): AudioClaimOutcome {
  if (typeof value !== 'object' || value === null) return { code: 'making', secret: null };
  const raw = value as Record<string, unknown>;
  const code: AudioClaimCode = isAudioClaimCode(raw.code) ? raw.code : 'making';
  return { code, secret: code === 'claimed' ? readClaimSecret(raw.secret) : null };
}

/** Server side. Carries the student's access token, so Postgres decides. */
export interface ExplanationAudioClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** The one transaction: visibility, readiness, and the race. */
  claimAudio(request: RevisionRequest): Promise<AudioClaimOutcome>;
  /** Point the row at the stored object. Needs the claim's own secret. */
  finishAudio(
    request: RevisionRequest,
    path: string,
    secret: string | null,
  ): Promise<boolean>;
  /** Release a claimed slot, so a later read may retry it. Needs the secret. */
  failAudio(request: RevisionRequest, secret: string | null): Promise<void>;
}

// --------------------------------------------------------------------------
// What gets read out, and where it is kept
// --------------------------------------------------------------------------

/**
 * The explanation as one block of speech.
 *
 * The question first, then every section (heading, then body), then the
 * Remember line. Headings are read out because they are how a student follows
 * the argument: "The answer", "Why the others are wrong".
 *
 * No markdown, no "section 1 of 3", no SSML: a voice provider reads what it
 * is given, and the stored body is plain text already.
 */
export function explanationSpeechText(body: ExplanationBody): string {
  const parts: string[] = [];

  if (body.question.trim().length > 0) parts.push(body.question.trim());

  for (const section of body.sections) {
    const heading = section.heading.trim();
    const text = section.body.trim();
    if (heading.length > 0) parts.push(heading);
    if (text.length > 0) parts.push(text);
  }

  if (body.remember.trim().length > 0) parts.push(body.remember.trim());

  // One newline between parts, so a provider hears a sentence break and the
  // text has no empty line a character counter would still be billed for.
  return parts.join('\n');
}

/**
 * Where the object lives in the bucket.
 *
 * Derived, never random: one (question, language) is one path, forever. So a
 * retry overwrites nothing and leaves no orphan, and a path can be rebuilt
 * from the row without storing a second id.
 */
export function explanationAudioPath(questionId: string, lang: Lang): string {
  return `explanations/${questionId}/${lang}.${AUDIO_EXTENSION}`;
}

/**
 * What the `<audio src>` points at.
 *
 * OUR route, never the bucket. The bucket is private, so the player needs a
 * signed URL, and a signed URL dies after an hour: putting one in the page
 * would break a student who left the tab open. The route mints a fresh one
 * per request instead.
 */
export function explanationAudioUrl(questionId: string, lang: Lang): string {
  const query = new URLSearchParams({ question_id: questionId, lang });
  return `/api/revision/audio?${query.toString()}`;
}

/**
 * Validate the audio route's query string into a request, or null.
 *
 * Same rule as `readRevisionRequest`: a uuid and one of the two STORED
 * languages, never the display mode `both`.
 */
export function readAudioRequest(params: URLSearchParams): RevisionRequest | null {
  const questionId = params.get('question_id') ?? params.get('questionId');
  if (typeof questionId !== 'string' || !UUID_RE.test(questionId)) return null;

  const lang = params.get('lang');
  if (lang !== 'en' && lang !== 'hi') return null;

  return { questionId, lang };
}
