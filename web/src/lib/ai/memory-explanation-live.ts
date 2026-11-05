/**
 * An in-memory `ExplanationLive` (issue 23-revision-screen).
 *
 * TWO uses, which is why it is shipped code and not a test helper, the same
 * reasoning as `questions/memory-live.ts`:
 *
 *  1. Tests. The revision screen's suite pushes a finished row and asserts on
 *     the next line, so no test opens a socket and no test holds a key
 *     (web/CLAUDE.md).
 *  2. The "not configured" screen. With no Supabase env vars the panel still
 *     has to render, and a stream that delivers nothing is a cleaner answer
 *     than a null check at every call site.
 *
 * `push` is synchronous on purpose: a test that pushes a row can assert with
 * no fake timers.
 */
import { explanationKey, type ExplanationLive } from './revision-screen';
import type { Explanation } from './types';

export interface MemoryExplanationLive {
  live: ExplanationLive;
  /** Deliver one row to whoever is watching that question and language. */
  push(explanation: Explanation): void;
  /** The keys currently being watched. Lets a test prove `stop()` works. */
  watching(): string[];
}

export function createMemoryExplanationLive(): MemoryExplanationLive {
  const watchers = new Map<string, Set<(explanation: Explanation) => void>>();

  return {
    live: {
      isConfigured() {
        return true;
      },

      watchExplanation(key, onChange) {
        const id = explanationKey(key.questionId, key.lang);
        const set = watchers.get(id) ?? new Set<(explanation: Explanation) => void>();
        set.add(onChange);
        watchers.set(id, set);

        let stopped = false;
        return () => {
          // Guarded, because React calls a cleanup twice on a fast remount.
          if (stopped) return;
          stopped = true;
          set.delete(onChange);
          if (set.size === 0) watchers.delete(id);
        };
      },
    },

    push(explanation: Explanation) {
      const id = explanationKey(explanation.questionId, explanation.lang);
      // A copy of the set: a watcher that stops itself inside its own callback
      // must not break the loop.
      for (const fn of [...(watchers.get(id) ?? [])]) fn(explanation);
    },

    watching() {
      return [...watchers.keys()];
    },
  };
}
