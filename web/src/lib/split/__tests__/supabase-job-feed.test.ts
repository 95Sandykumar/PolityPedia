/**
 * The Realtime insert listener (issue 12-pdf-split-worker, design check B6).
 *
 * The socket and the timer are injected, so this file never opens a connection
 * and never holds a real key (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FEED_HEARTBEAT_MS,
  createMemoryJobFeed,
  createSupabaseJobFeed,
  isJobInsert,
} from '../supabase-job-feed';
import type { LiveSocket, LiveTimer } from '@/lib/questions/supabase-live';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-not-a-real-key',
};

/** A `WebSocket` a test drives by hand. */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let closed = false;

  const socket: LiveSocket = {
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    close() {
      closed = true;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
  };

  return {
    socket,
    sent,
    isClosed: () => closed,
    open: () => listeners.get('open')?.(undefined),
    message: (data: unknown) => listeners.get('message')?.({ data }),
  };
}

function fakeTimer() {
  const beats: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const timer: LiveTimer = {
    set(fn, ms) {
      beats.push({ fn, ms });
      return beats.length - 1;
    },
    clear(handle) {
      cleared.push(handle);
    },
  };
  return { timer, beats, cleared };
}

const INSERT = JSON.stringify({
  event: 'postgres_changes',
  payload: { data: { type: 'INSERT', table: 'ingest_jobs', record: { id: 'x' } } },
});

describe('isJobInsert', () => {
  it('knows an ingest_jobs insert', () => {
    expect(isJobInsert(INSERT)).toBe(true);
  });

  it.each([
    ['an update', { event: 'postgres_changes', payload: { data: { type: 'UPDATE', table: 'ingest_jobs' } } }],
    ['another table', { event: 'postgres_changes', payload: { data: { type: 'INSERT', table: 'questions' } } }],
    ['a reply frame', { event: 'phx_reply', payload: {} }],
  ])('ignores %s', (_label, frame) => {
    expect(isJobInsert(JSON.stringify(frame))).toBe(false);
  });

  it('drops a frame it cannot parse instead of throwing', () => {
    // A broken push must never take the worker down. The sweep is the backstop.
    expect(isJobInsert('{not json')).toBe(false);
    expect(isJobInsert(undefined)).toBe(false);
    expect(isJobInsert(42)).toBe(false);
  });
});

describe('createSupabaseJobFeed', () => {
  it('watches nothing without keys', () => {
    const feed = createSupabaseJobFeed({ env: {} });
    expect(feed.isConfigured()).toBe(false);

    const open = vi.fn();
    // No socket is opened at all: the sweep still runs, so the worker works,
    // just 5 minutes slower.
    createSupabaseJobFeed({ env: {}, socketFactory: open }).watchNewJobs(() => undefined);
    expect(open).not.toHaveBeenCalled();
  });

  it('joins for INSERT only, then beats to stay alive', () => {
    const fake = fakeSocket();
    const { timer, beats } = fakeTimer();
    const urls: string[] = [];

    const feed = createSupabaseJobFeed({
      env: ENV,
      socketFactory: (url) => {
        urls.push(url);
        return fake.socket;
      },
      timer,
    });
    expect(feed.isConfigured()).toBe(true);

    const stop = feed.watchNewJobs(() => undefined);
    fake.open();

    expect(urls[0]).toContain('wss://project.supabase.co/realtime/v1/websocket');

    const join = fake.sent[0] as { event: string; payload: { config: { postgres_changes: { event: string; table: string }[] } } };
    expect(join.event).toBe('phx_join');
    // INSERT only: the worker does not care that a teacher edited a row, only
    // that there is new work.
    expect(join.payload.config.postgres_changes[0]).toMatchObject({
      event: 'INSERT',
      table: 'ingest_jobs',
    });

    // The token arrives AFTER the join, so the channel exists when it lands.
    expect(fake.sent[1].event).toBe('access_token');

    expect(beats).toHaveLength(1);
    expect(beats[0].ms).toBe(FEED_HEARTBEAT_MS);
    stop();
  });

  it('calls back once per insert and never for anything else', () => {
    const fake = fakeSocket();
    const { timer } = fakeTimer();
    const woken: number[] = [];

    const stop = createSupabaseJobFeed({
      env: ENV,
      socketFactory: () => fake.socket,
      timer,
    }).watchNewJobs(() => woken.push(woken.length));

    fake.open();
    fake.message(INSERT);
    fake.message(JSON.stringify({ event: 'phx_reply', payload: {} }));
    fake.message(INSERT);

    expect(woken).toHaveLength(2);

    stop();
    // After the stop a frame does nothing: PM2 shut the worker down.
    fake.message(INSERT);
    expect(woken).toHaveLength(2);
  });

  it('leaves and closes on stop, and stopping twice is safe', () => {
    const fake = fakeSocket();
    const { timer, cleared } = fakeTimer();

    const stop = createSupabaseJobFeed({
      env: ENV,
      socketFactory: () => fake.socket,
      timer,
    }).watchNewJobs(() => undefined);

    fake.open();
    const before = fake.sent.length;
    stop();
    stop(); // PM2 can send SIGINT and SIGTERM in quick succession.

    expect(fake.sent[before].event).toBe('phx_leave');
    expect(fake.sent).toHaveLength(before + 1); // only ONE leave
    expect(fake.isClosed()).toBe(true);
    expect(cleared).toHaveLength(1);
  });

  it('survives a socket the runtime refuses to open', () => {
    const stop = createSupabaseJobFeed({
      env: ENV,
      socketFactory: () => {
        throw new Error('no sockets here');
      },
    }).watchNewJobs(() => undefined);

    // The documented fallback is the sweep, so this is not worth crashing for.
    expect(() => stop()).not.toThrow();
  });
});

describe('createMemoryJobFeed', () => {
  it('pushes to every watcher and forgets the stopped ones', () => {
    const feed = createMemoryJobFeed();
    let a = 0;
    let b = 0;

    const stopA = feed.feed.watchNewJobs(() => (a += 1));
    feed.feed.watchNewJobs(() => (b += 1));
    expect(feed.watchers()).toBe(2);

    feed.push();
    expect([a, b]).toEqual([1, 1]);

    stopA();
    stopA();
    feed.push();
    expect([a, b]).toEqual([1, 2]);
    expect(feed.watchers()).toBe(1);
  });
});
