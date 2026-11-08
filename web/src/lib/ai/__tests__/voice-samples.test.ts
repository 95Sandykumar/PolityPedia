/**
 * The sample maker's own rules (issue 43-h4-voice-providers).
 *
 * Only the parts that need no network and no key: the argument reading, the
 * built-in sample texts, and the FIRST RUN, where nothing is set up and the
 * job must name the variables and exit 0 rather than look like a crash.
 *
 * The paths that call a provider are not driven here, because driving them
 * would mean a real paid call (web/CLAUDE.md). The providers themselves are
 * covered with a fake fetch in `elevenlabs-speech.test.ts` and
 * `google-speech.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_EN, SAMPLE_HI, main, readTexts } from '../../../../jobs/voice-samples';

/** Words, the way the issue counts them: runs of non-space. */
function words(text: string): number {
  return text.trim().split(/\s+/).length;
}

describe('the built-in sample texts', () => {
  it('are a real explanation in each language, 60 to 90 words', () => {
    expect(words(SAMPLE_EN)).toBeGreaterThanOrEqual(60);
    expect(words(SAMPLE_EN)).toBeLessThanOrEqual(90);
    expect(words(SAMPLE_HI)).toBeGreaterThanOrEqual(60);
    expect(words(SAMPLE_HI)).toBeLessThanOrEqual(90);
  });

  it('write Hindi in Devanagari, not in English letters', () => {
    expect(SAMPLE_HI).toMatch(/[ऀ-ॿ]/);
    expect(SAMPLE_EN).not.toMatch(/[ऀ-ॿ]/);
  });

  it('use no em dash and no en dash, so a voice does not read one out', () => {
    for (const text of [SAMPLE_EN, SAMPLE_HI]) {
      expect(text).not.toContain('—');
      expect(text).not.toContain('–');
    }
  });
});

describe('readTexts', () => {
  it('falls back to the built-in samples with no arguments', () => {
    expect(readTexts([])).toEqual({ en: SAMPLE_EN, hi: SAMPLE_HI });
  });

  it('takes --text-en and --text-hi as a separate value', () => {
    expect(readTexts(['--text-en', 'mine', '--text-hi', 'मेरा'])).toEqual({
      en: 'mine',
      hi: 'मेरा',
    });
  });

  it('takes the --flag=value spelling too', () => {
    expect(readTexts(['--text-hi=मेरा'])).toEqual({ en: SAMPLE_EN, hi: 'मेरा' });
  });

  it('ignores an empty or missing value, so a typo cannot send silence', () => {
    expect(readTexts(['--text-en', '  '])).toEqual({ en: SAMPLE_EN, hi: SAMPLE_HI });
    expect(readTexts(['--text-en'])).toEqual({ en: SAMPLE_EN, hi: SAMPLE_HI });
  });
});

describe('main with nothing set up', () => {
  it('names every variable for both providers, makes nothing, and exits 0', async () => {
    const result = await main([], {});

    expect(result.exitCode).toBe(0);
    expect(result.made).toBe(0);

    const printed = result.lines.join('\n');
    for (const name of [
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_VOICE_EN',
      'ELEVENLABS_VOICE_HI',
      'GOOGLE_TTS_API_KEY',
    ]) {
      expect(printed).toContain(name);
    }
    expect(printed).toContain('web/.env.local');
    expect(printed).toContain('jobs/voice-samples.README.md');
  });
});
