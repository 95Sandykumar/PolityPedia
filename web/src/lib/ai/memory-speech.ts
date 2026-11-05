/**
 * In-memory Speech (issue 25-revision-audio).
 *
 * This is the FAKE the issue asks for: every test that touches audio uses it,
 * so no test ever calls a paid voice provider or holds a real key
 * (web/CLAUDE.md).
 *
 * It is a real implementation of the interface, not a mock: it returns real
 * bytes, and it RECORDS every call, because "the voice is called once per
 * (question, language)" is the thing the slice has to prove and a count is
 * the only honest way to prove it.
 */
import type { Lang } from '@/lib/i18n';
import { AUDIO_CONTENT_TYPE, type Speech } from './audio';

export interface SpeechCall {
  text: string;
  lang: Lang;
}

export interface MemorySpeech {
  speech: Speech;
  /** Every call, in the order it arrived. */
  calls(): SpeechCall[];
  /** Make the next call fail once, to test the unhappy path. */
  failNext(): void;
}

export function createMemorySpeech(): MemorySpeech {
  const calls: SpeechCall[] = [];
  let failOnce = false;

  const speech: Speech = {
    isConfigured() {
      return true;
    },

    contentType: AUDIO_CONTENT_TYPE,

    async speak(text: string, lang: Lang) {
      if (failOnce) {
        failOnce = false;
        throw new Error('memory voice was told to fail');
      }
      calls.push({ text, lang });
      // One byte per character, so a test can tell "something was made" from
      // "nothing was made" without a fixture file.
      return new Uint8Array(Math.max(text.length, 1));
    },
  };

  return {
    speech,
    calls() {
      return [...calls];
    },
    failNext() {
      failOnce = true;
    },
  };
}
