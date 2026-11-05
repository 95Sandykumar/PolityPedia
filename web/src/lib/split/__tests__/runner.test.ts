/**
 * The two triggers and the "one at a time" rule
 * (issue 12-pdf-split-worker, design.md D1 and B6).
 *
 * The timer and the feed are both fakes, so nothing here opens a socket or
 * waits 5 real minutes (web/CLAUDE.md).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryJobFeed, type MemoryJobFeed } from '../supabase-job-feed';
import { SWEEP_MS, createSplitRunner, type RunnerTimer } from '../runner';
import type { SplitOutcome } from '../worker';

const IDLE: SplitOutcome = { type: 'idle' };

function done(jobId: string): SplitOutcome {
  return { type: 'done', jobId, questionCount: 1, attempts: 1 };
}

/** A `setInterval` a test can fire by hand. */
function fakeTimer() {
  const ticks: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const timer: RunnerTimer = {
    set(fn, ms) {
      ticks.push({ fn, ms });
      return ticks.length - 1;
    },
    clear(handle) {
      cleared.push(handle);
    },
  };
  return { timer, ticks, cleared, tick: () => ticks.forEach((one) => one.fn()) };
}

/** A `runOnce` that hands back a scripted list of outcomes. */
function scripted(outcomes: SplitOutcome[]) {
  const seen: number[] = [];
  let calls = 0;
  return {
    runOnce: async () => {
      calls += 1;
      seen.push(calls);
      return outcomes.shift() ?? IDLE;
    },
    calls: () => calls,
  };
}

let feed: MemoryJobFeed;

beforeEach(() => {
  feed = createMemoryJobFeed();
});

describe('createSplitRunner', () => {
  it('drains the queue once at startup', async () => {
    const script = scripted([done('a'), done('b')]);
    const outcomes: SplitOutcome[] = [];
    const { timer } = fakeTimer();

    const runner = createSplitRunner({
      runOnce: script.runOnce,
      feed: feed.feed,
      timer,
      onOutcome: (one) => outcomes.push(one),
    });
    const stop = runner.start();
    await runner.idle();
    stop();

    // PM2 restarts the worker, so anything queued while it was down is picked
    // up without waiting for the first sweep.
    expect(script.calls()).toBe(3); // two jobs, then idle
    expect(outcomes.map((one) => one.type)).toEqual(['done', 'done', 'idle']);
  });

  it('wakes on a Realtime insert (B6)', async () => {
    const script = scripted([IDLE, done('a')]);
    const { timer } = fakeTimer();

    const runner = createSplitRunner({ runOnce: script.runOnce, feed: feed.feed, timer });
    const stop = runner.start();
    await runner.idle();
    expect(script.calls()).toBe(1); // startup drain found nothing

    feed.push();
    await runner.idle();
    stop();

    // The teacher does not wait up to 5 minutes for the sweep.
    expect(script.calls()).toBe(3); // the job, then idle
  });

  it('sweeps every 5 minutes as a fallback', async () => {
    const script = scripted([IDLE, done('a')]);
    const { timer, ticks, tick } = fakeTimer();

    const runner = createSplitRunner({ runOnce: script.runOnce, feed: feed.feed, timer });
    const stop = runner.start();
    await runner.idle();

    expect(ticks).toHaveLength(1);
    expect(ticks[0].ms).toBe(SWEEP_MS);
    expect(SWEEP_MS).toBe(5 * 60 * 1000);

    tick();
    await runner.idle();
    stop();

    expect(script.calls()).toBe(3);
  });

  it('sweeps even with no feed at all', async () => {
    const script = scripted([done('a')]);
    const { timer, tick } = fakeTimer();

    // No keys for Realtime: the worker still works, 5 minutes slower.
    const runner = createSplitRunner({ runOnce: script.runOnce, timer });
    const stop = runner.start();
    await runner.idle();
    tick();
    await runner.idle();
    stop();

    expect(script.calls()).toBeGreaterThanOrEqual(2);
  });

  it('runs ONE job at a time, whatever arrives (D1)', async () => {
    let inFlight = 0;
    let highWater = 0;
    let calls = 0;
    // A holder, not a bare `let`: TypeScript narrows a variable assigned only
    // inside a callback down to `null` at the call site below.
    const gate: { release: () => void } = { release: () => undefined };

    const runner = createSplitRunner({
      runOnce: async () => {
        inFlight += 1;
        highWater = Math.max(highWater, inFlight);
        calls += 1;
        // The first call parks until the test lets it go, so every trigger
        // below arrives while a job is genuinely in flight.
        if (calls === 1) await new Promise<void>((resolve) => (gate.release = resolve));
        inFlight -= 1;
        return calls <= 2 ? done('job-' + calls) : IDLE;
      },
      feed: feed.feed,
      timer: fakeTimer().timer,
    });

    const stop = runner.start();
    expect(runner.busy()).toBe(true);

    // Five uploads land at once while the first job is still running.
    for (let i = 0; i < 5; i += 1) feed.push();

    gate.release();
    await runner.idle();
    stop();

    // Never two splits at once: that is what "1 job at a time" means, and it
    // is what keeps one teacher's upload from stalling behind five others'.
    expect(highWater).toBe(1);
  });

  it('keeps running when a job throws, and reports it', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const { timer, tick } = fakeTimer();

    const runner = createSplitRunner({
      runOnce: async () => {
        calls += 1;
        if (calls === 1) throw new Error('supabase is down');
        return IDLE;
      },
      feed: feed.feed,
      timer,
      onError: (error) => errors.push(error),
    });

    const stop = runner.start();
    await runner.idle();

    // A dead database is a reason to wait, not a reason to kill the PM2 app.
    expect(errors).toHaveLength(1);
    expect(runner.busy()).toBe(false);

    tick();
    await runner.idle();
    stop();
    expect(calls).toBe(2);
  });

  it('stops both triggers, and stopping twice is safe', async () => {
    const script = scripted([IDLE]);
    const { timer, cleared } = fakeTimer();

    const runner = createSplitRunner({ runOnce: script.runOnce, feed: feed.feed, timer });
    const stop = runner.start();
    await runner.idle();

    expect(feed.watchers()).toBe(1);

    stop();
    stop(); // PM2 can send SIGINT and SIGTERM in quick succession.

    expect(feed.watchers()).toBe(0);
    expect(cleared).toHaveLength(1);

    // A push after the stop does nothing.
    const before = script.calls();
    feed.push();
    await runner.idle();
    expect(script.calls()).toBe(before);
  });
});
