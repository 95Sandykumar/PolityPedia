/**
 * The price maths behind the sample maker (issue 43-h4-voice-providers).
 *
 * The numbers in the table are UNVERIFIED on purpose: Boss checks them on the
 * provider's own pricing page. What this test pins down is the ARITHMETIC, so
 * a number Boss reads off the sample run cannot be wrong by a factor of a
 * thousand, which is exactly the mistake a per-1000-characters table invites.
 */
import { describe, expect, it } from 'vitest';
import {
  VOICE_PRICES,
  countCharacters,
  estimateUsd,
  formatUsd,
} from '../../../../jobs/voice-prices';

describe('countCharacters', () => {
  it('counts what a provider bills: every character of the text', () => {
    expect(countCharacters('Article 80.')).toBe(11);
    expect(countCharacters('')).toBe(0);
    // Devanagari is counted in characters, not bytes, same as the billing unit.
    expect(countCharacters('अनुच्छेद')).toBe('अनुच्छेद'.length);
  });
});

describe('estimateUsd', () => {
  it('charges the table rate for exactly 1000 characters', () => {
    for (const provider of ['elevenlabs', 'google'] as const) {
      expect(estimateUsd(provider, 1_000)).toBeCloseTo(VOICE_PRICES[provider].usdPer1000Chars, 10);
    }
  });

  it('scales straight with the character count', () => {
    const rate = VOICE_PRICES.elevenlabs.usdPer1000Chars;
    expect(estimateUsd('elevenlabs', 500)).toBeCloseTo(rate / 2, 10);
    expect(estimateUsd('elevenlabs', 2_500)).toBeCloseTo(rate * 2.5, 10);
    expect(estimateUsd('elevenlabs', 0)).toBe(0);
  });

  it('never returns a negative price', () => {
    expect(estimateUsd('google', -100)).toBe(0);
  });

  it('keeps the two providers independent', () => {
    expect(estimateUsd('google', 1_000)).not.toBeCloseTo(
      estimateUsd('elevenlabs', 1_000),
      6,
    );
  });
});

describe('formatUsd', () => {
  it('shows small money without rounding it away to zero', () => {
    expect(formatUsd(0.22)).toBe('$0.2200');
    expect(formatUsd(0.000016)).toBe('$0.0000');
    expect(formatUsd(0)).toBe('$0.0000');
  });
});

describe('VOICE_PRICES', () => {
  it('marks every rate as unverified, with the page Boss must check', () => {
    for (const provider of ['elevenlabs', 'google'] as const) {
      const row = VOICE_PRICES[provider];
      expect(row.usdPer1000Chars).toBeGreaterThan(0);
      expect(row.verified).toBe(false);
      expect(row.source).toMatch(/^https:\/\//);
      expect(row.checkedOn).toBe('2026-11-06');
    }
  });
});
