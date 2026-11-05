/**
 * What keeps the worker awake (issue 12-pdf-split-worker, design.md P9).
 *
 * `runOnce` does one job. This file decides WHEN to call it, and it has
 * exactly two triggers:
 *
 *  1. A Realtime insert on `ingest_jobs`. B6: the job status is pushed, so a
 *     teacher who just uploaded is not left watching a spinner.
 *  2. A sweep every 5 minutes. The fallback for a dropped socket, a job
 *     queued while the worker was restarting, or a `queued` row a browser
 *     wrote without Realtime reaching us.
 *
 * ONE AT A TIME (design.md D1/D5). `drain()` is the only caller of `runOnce`,
 * and the `draining` flag means a second trigger while a job is in flight sets
 * `again` instead of starting a parallel split. So twenty uploads arriving
 * together are twenty sequential jobs, not twenty concurrent calls to Claude.
 *
 * The timer and the feed are injected, so the test drives both triggers with
 * no socket and no real clock (web/CLAUDE.md).
 *
 * It never logs. The outcome goes to the `onOutcome` callback and the entry
 * point decides what to print, which keeps ids and PDF paths out of this file.
 */
import type { JobFeed } from './types';
import type { SplitOutcome } from './worker';

/** design.md: "sweep every 5 min as fallback". */
export const SWEEP_MS = 5 * 60 * 1000;

/** `setInterval` / `clearInterval`, injected so a test can fire the sweep. */
export interface RunnerTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SplitRunnerOptions {
  /** One job. Normally `() => runOnce({ store, splitter, files })`. */
  runOnce: () => Promise<SplitOutcome>;
  /** Realtime inserts. Omitted = sweep only, which still works. */
  feed?: JobFeed;
  timer?: RunnerTimer;
  sweepMs?: number;
  /** Called once per finished job, so the entry point can report it. */
  onOutcome?: (outcome: SplitOutcome) => void;
  /**
   * Called when `runOnce` THREW, which means the store itself is unreachable.
   * The runner keeps going: the next sweep tries again, because a dead
   * Supabase is a reason to wait, not a reason to kill the PM2 app.
   */
  onError?: (error: unknown) => void;
}

export interface SplitRunner {
  /** Drain the queue now. Safe while a job is already running. */
  wake(): void;
  /** Start both triggers. Returns the stop function; calling it twice is safe. */
  start(): () => void;
  /** True while a job is in flight. Lets a test await the drain. */
  busy(): boolean;
  /** Resolves when the current drain is finished. For tests and shutdown. */
  idle(): Promise<void>;
}

export function createSplitRunner(options: SplitRunnerOptions): SplitRunner {
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const timer: RunnerTimer =
    options.timer ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };

  let draining: Promise<void> | null = null;
  /** A trigger arrived while we were busy. Drain once more when we are free. */
  let again = false;
  let stopped = false;

  /**
   * Run jobs until the queue is empty.
   *
   * The loop matters: one Realtime push can mean several new rows, and without
   * it a batch of uploads would sit until the next sweep.
   */
  async function drain(): Promise<void> {
    do {
      again = false;
      // An inner loop, so a queue of ten jobs is drained on one wake-up.
      for (;;) {
        if (stopped) return;
        let outcome: SplitOutcome;
        try {
          outcome = await options.runOnce();
        } catch (error) {
          // The store is unreachable. Stop draining and wait for the sweep:
          // hammering a dead database in a tight loop would be worse.
          options.onError?.(error);
          return;
        }
        options.onOutcome?.(outcome);
        if (outcome.type === 'idle') break;
      }
    } while (again);
  }

  function wake() {
    if (stopped) return;
    if (draining) {
      // Already working. Remember that something new arrived.
      again = true;
      return;
    }
    draining = drain().finally(() => {
      draining = null;
    });
  }

  return {
    wake,

    start() {
      stopped = false;

      // The sweep runs whatever the socket does, so a feed that silently dies
      // costs at most 5 minutes of delay, never a lost job.
      const sweep = timer.set(wake, sweepMs);
      const unwatch = options.feed?.isConfigured()
        ? options.feed.watchNewJobs(wake)
        : undefined;

      // Once at startup: PM2 restarts the worker, and anything queued while it
      // was down has to be picked up without waiting for the first sweep.
      wake();

      let done = false;
      return () => {
        // Guarded: PM2 can send SIGINT and SIGTERM in quick succession.
        if (done) return;
        done = true;
        stopped = true;
        timer.clear(sweep);
        unwatch?.();
      };
    },

    busy() {
      return draining !== null;
    },

    async idle() {
      // A `while`, because a drain can set `again` and start another pass.
      while (draining) await draining;
    },
  };
}
