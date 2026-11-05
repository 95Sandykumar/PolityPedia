/**
 * An in-memory `Live` (issue 11-ingest-job-review-publish).
 *
 * TWO uses, which is why it is shipped code and not a test helper:
 *
 *  1. Tests. Every suite that touches the review screen uses it, so no test
 *     opens a socket and no test holds a key (web/CLAUDE.md).
 *  2. The "not configured" page. With no Supabase env vars the screen still
 *     has to render, and a `Live` that delivers nothing is a cleaner answer
 *     than a null check at every call site.
 *
 * `push` is synchronous on purpose: a test that pushes a job can assert on the
 * next line with no `await` and no fake timers.
 */
import type { IngestJob, Live } from './types';

export interface MemoryLive {
  live: Live;
  /** Deliver one job row to whoever is watching that job id. */
  push(job: IngestJob): void;
  /** The job ids currently being watched. Lets a test prove `stop()` works. */
  watching(): string[];
}

export function createMemoryLive(): MemoryLive {
  const watchers = new Map<string, Set<(job: IngestJob) => void>>();

  return {
    live: {
      isConfigured() {
        return true;
      },

      watchJob(jobId, onChange) {
        const set = watchers.get(jobId) ?? new Set();
        set.add(onChange);
        watchers.set(jobId, set);

        let stopped = false;
        return () => {
          // Guarded, because React calls a cleanup twice on a fast remount.
          if (stopped) return;
          stopped = true;
          set.delete(onChange);
          if (set.size === 0) watchers.delete(jobId);
        };
      },
    },

    push(job: IngestJob) {
      // A copy of the set: a watcher that stops itself inside its own callback
      // must not break the loop.
      for (const fn of [...(watchers.get(job.id) ?? [])]) fn(job);
    },

    watching() {
      return [...watchers.keys()];
    },
  };
}
