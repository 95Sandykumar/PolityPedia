/**
 * What a voice sample roughly costs (issue 43-h4-voice-providers).
 *
 * This table exists so the sample run prints a number next to each mp3, and
 * Boss can compare "how it sounds" against "what it costs" in one screen.
 *
 * EVERY RATE HERE IS UNVERIFIED. Nobody has logged into either provider's
 * billing page from this repo, and both pages are rendered by JavaScript, so
 * they cannot be read by a script either. The numbers are a starting guess in
 * the right order of magnitude, nothing more. `verified: false` is printed
 * beside every estimate for exactly that reason, and the estimate is a reason
 * to go and look, never a figure to put in a plan.
 *
 * Per 1000 CHARACTERS, not per 1000 words and not per minute: both providers
 * bill by character, which is also why `F-F5` makes the app store each
 * explanation's audio once.
 *
 * Kept out of `src/` on purpose: nothing the app serves reads a price. It is
 * imported by `jobs/voice-samples.ts` and by its unit test.
 */

/** The two candidates for X5. Same spelling as `VOICE_PROVIDER`. */
export type VoicePriceProvider = 'elevenlabs' | 'google';

export interface VoicePrice {
  /** What to call it in the printout. */
  label: string;
  /** US dollars per 1000 characters of text sent. */
  usdPer1000Chars: number;
  /** Always false in this file. Flips only when a human has checked. */
  verified: boolean;
  /** The page a human must open to replace the guess with a fact. */
  source: string;
  /** When the guess was written down, so its age is visible. */
  checkedOn: string;
}

const CHECKED_ON = '2026-11-06';

export const VOICE_PRICES: Record<VoicePriceProvider, VoicePrice> = {
  elevenlabs: {
    label: 'ElevenLabs (eleven_multilingual_v2)',
    // UNVERIFIED, check the provider's pricing page. Written 2026-11-06.
    // Order-of-magnitude guess from the published Creator tier: about 100,000
    // credits for about 22 US dollars, one credit per character on a
    // multilingual model. The docs confirm only the SHAPE of the price
    // ("cost per character", and Flash v2.5 at "50% lower price per
    // character"); no page states a number.
    usdPer1000Chars: 0.22,
    verified: false,
    source: 'https://elevenlabs.io/pricing/api',
    checkedOn: CHECKED_ON,
  },
  google: {
    label: 'Google Cloud TTS (Neural2)',
    // UNVERIFIED, check the provider's pricing page. Written 2026-11-06.
    // Order-of-magnitude guess for the Neural2 tier: about 16 US dollars per
    // 1 million characters, which is 0.016 per 1000. The pricing page is
    // client-side rendered and returned no table to a script, so this number
    // has not been read anywhere.
    usdPer1000Chars: 0.016,
    verified: false,
    source: 'https://cloud.google.com/text-to-speech/pricing',
    checkedOn: CHECKED_ON,
  },
};

/**
 * What a provider bills for: characters of text.
 *
 * `String.length` counts UTF-16 units, which is what both providers' own
 * character counters use, so Devanagari is counted the same way they count it.
 * Not bytes: a byte count would triple the Hindi estimate.
 */
export function countCharacters(text: string): number {
  return text.length;
}

/** The estimate, in US dollars. Never negative, so a bad count cannot read as a credit. */
export function estimateUsd(provider: VoicePriceProvider, characters: number): number {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  return (characters / 1_000) * VOICE_PRICES[provider].usdPer1000Chars;
}

/**
 * Money for a human to read. Four decimals, because one sample of an
 * explanation costs a fraction of a cent and two decimals would print
 * every Google sample as "$0.00".
 */
export function formatUsd(amount: number): string {
  return '$' + amount.toFixed(4);
}
