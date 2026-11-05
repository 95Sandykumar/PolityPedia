/**
 * Issue 04-exams-onboarding: the i18n guard.
 *
 * Every label a user sees must exist in English AND Hindi (web/CLAUDE.md,
 * DESIGN.md section 1). This test fails the build if a key is added to only
 * one dictionary, which is how a Hindi screen ends up with an English word.
 */
import { describe, expect, it } from 'vitest';
import { LANG_MODES, dictionary, isLangMode, labels, plain } from '../i18n';

describe('i18n dictionary', () => {
  it('has the same keys in English and Hindi', () => {
    expect(Object.keys(dictionary.hi).sort()).toEqual(Object.keys(dictionary.en).sort());
  });

  it('has no empty string in either language', () => {
    for (const lang of ['en', 'hi'] as const) {
      for (const [key, value] of Object.entries(dictionary[lang])) {
        expect(value.trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('carries the onboarding and language labels this issue adds', () => {
    for (const key of [
      'onboarding.title',
      'onboarding.exams',
      'onboarding.language',
      'onboarding.continue',
      'onboarding.saving',
      'onboarding.failed',
      'onboarding.notConfigured',
      'me.language',
      'me.saved',
      'lang.en',
      'lang.hi',
      'lang.both',
    ] as const) {
      expect(dictionary.en[key]).toBeTruthy();
      expect(dictionary.hi[key]).toBeTruthy();
    }
  });
});

describe('language modes', () => {
  it('offers exactly English, Hindi and Both, in that order', () => {
    expect(LANG_MODES).toEqual(['en', 'hi', 'both']);
  });

  it('accepts only those three values', () => {
    expect(isLangMode('en')).toBe(true);
    expect(isLangMode('both')).toBe(true);
    expect(isLangMode('hinglish')).toBe(false);
    expect(isLangMode(undefined)).toBe(false);
  });

  it('shows one line per language, English first, in both mode', () => {
    expect(labels('lang.both', 'both')).toEqual([dictionary.en['lang.both'], dictionary.hi['lang.both']]);
    expect(plain('lang.both', 'both')).toContain(' / ');
  });
});
