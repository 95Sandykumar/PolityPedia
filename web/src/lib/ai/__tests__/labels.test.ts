/**
 * Every revision reply code has a label, in English AND Hindi
 * (issue 22-revision-api, web/CLAUDE.md).
 *
 * The route answers with a code. If a code had no label, the UI would have to
 * invent an English-only string, which is exactly the rule this checks.
 */
import { describe, expect, it } from 'vitest';
import { dictionary, t } from '@/lib/i18n';
import { REVISION_ERROR_LABEL } from '../labels';

const REVISION_KEYS = Object.keys(dictionary.en).filter((key) => key.startsWith('revision.'));

describe('revision labels', () => {
  it('exist in both languages and are never blank', () => {
    expect(REVISION_KEYS.length).toBeGreaterThan(5);
    for (const key of REVISION_KEYS) {
      for (const lang of ['en', 'hi'] as const) {
        const label = t(key as keyof typeof dictionary.en, lang);
        expect(label, `${key} (${lang})`).toBeTruthy();
        expect(label.trim().length, `${key} (${lang})`).toBeGreaterThan(0);
      }
    }
  });

  it('are different text in the two languages', () => {
    // A copied English string in the Hindi block is the usual way a label
    // "exists" in Hindi without being translated. Latin-digit numbers and the
    // "AI" mark are allowed to repeat, so only the letters are compared.
    for (const key of REVISION_KEYS) {
      const en = t(key as keyof typeof dictionary.en, 'en');
      const hi = t(key as keyof typeof dictionary.en, 'hi');
      expect(hi, key).not.toBe(en);
      expect(/[ऀ-ॿ]/.test(hi), `${key} has no Devanagari`).toBe(true);
    }
  });

  it('covers every code the route can answer with', () => {
    for (const [code, key] of Object.entries(REVISION_ERROR_LABEL)) {
      expect(REVISION_KEYS, code).toContain(key);
    }
  });
});
