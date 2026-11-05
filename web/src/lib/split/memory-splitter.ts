/**
 * In-memory QuestionSplitter (issue 12-pdf-split-worker).
 *
 * This is the FAKE the issue asks for: every test of the worker uses it, so no
 * test calls Claude, holds a key or spends a token (web/CLAUDE.md). The live
 * check against the real API is ticket H3.
 *
 * It is scripted, not clever: `willAnswer` and `willThrow` queue up what the
 * next call gets back, in order, which is how one test can say "bad answer,
 * bad answer, good answer" and watch the retry rule work.
 *
 * Shipped code rather than a test helper, like `memory-file-store.ts` and
 * `memory-live.ts`, so a dev run of the worker with no key can be wired to it
 * instead of growing a second code path inside the worker itself.
 */
import type { QuestionSplitter, SplitRequest } from './types';

type Step = { kind: 'answer'; value: unknown } | { kind: 'throw'; message: string };

export interface MemorySplitter extends QuestionSplitter {
  /** The next call returns this, unvalidated. */
  willAnswer(value: unknown): void;
  /** The next call throws, like a 500 or a dropped connection would. */
  willThrow(message?: string): void;
  /** How many times the worker asked the model. Proves the retry cap. */
  calls(): number;
  /** The requests that were made, so a test can check the cap it was told. */
  requests(): SplitRequest[];
  /** Pretend the API key is missing. */
  setConfigured(value: boolean): void;
}

export function createMemorySplitter(): MemorySplitter {
  const steps: Step[] = [];
  const seen: SplitRequest[] = [];
  let configured = true;

  return {
    isConfigured() {
      return configured;
    },

    async split(request: SplitRequest) {
      seen.push(request);
      const step = steps.shift();
      // Nothing scripted means the test did not expect another call. An empty
      // object is a BAD answer, so the worker's own rules decide what happens
      // and the test fails on the outcome rather than on a thrown helper.
      if (!step) return {};
      if (step.kind === 'throw') throw new Error(step.message);
      return step.value;
    },

    willAnswer(value: unknown) {
      steps.push({ kind: 'answer', value });
    },

    willThrow(message = 'memory splitter was told to fail') {
      steps.push({ kind: 'throw', message });
    },

    calls() {
      return seen.length;
    },

    requests() {
      return [...seen];
    },

    setConfigured(value: boolean) {
      configured = value;
    },
  };
}
