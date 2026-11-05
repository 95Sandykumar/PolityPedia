/**
 * The pushed job stream (issue 11-ingest-job-review-publish).
 *
 * Design check B6: the job status is PUSHED, never polled. So this file proves
 * there is no timer waiting for the next status, only a socket the server
 * writes into.
 *
 * The WebSocket is injected, so nothing here opens a connection and no real
 * key is used (web/CLAUDE.md). The fake socket records every frame, which is
 * how the Realtime handshake itself is checked.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryLive } from '../memory-live';
import {
  HEARTBEAT_MS,
  createSupabaseLive,
  realtimeUrl,
  type LiveSocket,
} from '../supabase-live';
import type { IngestJob } from '../types';

const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAPER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEACHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://demo.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    teacher_id: TEACHER,
    paper_id: PAPER,
    pdf_path: 'papers/q.pdf',
    status: 'running',
    attempts: 1,
    error: null,
    question_count: 42,
    ...over,
  };
}

interface Frame {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

/** A WebSocket that records what was sent and lets a test push a frame back. */
function fakeSocket() {
  const sent: Frame[] = [];
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  let closed = 0;

  const socket: LiveSocket = {
    send(data: string) {
      sent.push(JSON.parse(data) as Frame);
    },
    close() {
      closed += 1;
    },
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
  };

  function fire(type: string, event: unknown) {
    for (const fn of handlers.get(type) ?? []) fn(event);
  }

  return {
    socket,
    sent,
    get closed() {
      return closed;
    },
    open: () => fire('open', {}),
    /** What the server pushes when the job row changes. */
    push: (record: Record<string, unknown>) =>
      fire('message', {
        data: JSON.stringify({
          topic: `realtime:ingest_job:${JOB}`,
          event: 'postgres_changes',
          payload: { data: { type: 'UPDATE', record } },
        }),
      }),
    raw: (text: string) => fire('message', { data: text }),
    drop: () => fire('close', {}),
  };
}

/** A timer that never fires on its own, so a test runs the heartbeat by hand. */
function fakeTimer() {
  const ticks: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  return {
    timer: {
      set(fn: () => void, ms: number) {
        ticks.push({ fn, ms });
        return ticks.length;
      },
      clear() {
        cleared += 1;
      },
    },
    ticks,
    get cleared() {
      return cleared;
    },
  };
}

function setup(env: Record<string, string | undefined> = ENV) {
  const net = fakeSocket();
  const clock = fakeTimer();
  const urls: string[] = [];

  const live = createSupabaseLive({
    accessToken: 'teacher-token',
    env,
    socketFactory: (url) => {
      urls.push(url);
      return net.socket;
    },
    timer: clock.timer,
  });

  return { live, net, clock, urls };
}

describe('realtimeUrl', () => {
  it('turns the https project URL into a wss socket URL', () => {
    expect(realtimeUrl('https://demo.supabase.co', 'anon-key')).toBe(
      'wss://demo.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0',
    );
  });

  it('keeps a trailing slash out of the path', () => {
    expect(realtimeUrl('https://demo.supabase.co/', 'k')).toContain(
      'demo.supabase.co/realtime/v1/websocket',
    );
  });

  it('uses ws for a plain http project URL, so a local stack works', () => {
    expect(realtimeUrl('http://127.0.0.1:54321', 'k')).toBe(
      'ws://127.0.0.1:54321/realtime/v1/websocket?apikey=k&vsn=1.0.0',
    );
  });

  it('escapes the key, because it goes in a query string', () => {
    expect(realtimeUrl('https://demo.supabase.co', 'a b/c')).toContain('apikey=a%20b%2Fc');
  });
});

describe('createSupabaseLive', () => {
  it('says it is not configured with no env, and watches nothing', () => {
    const { live, urls } = setup({});
    expect(live.isConfigured()).toBe(false);

    const onChange = vi.fn();
    const stop = live.watchJob(JOB, onChange);
    // No socket was opened at all, so a page with no keys costs nothing.
    expect(urls).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('refuses a job id that is not a uuid, because it goes in a filter', () => {
    const { live, urls } = setup();
    live.watchJob('job-1', vi.fn())();
    expect(urls).toEqual([]);
  });

  it('joins the job row with a postgres_changes filter', () => {
    const { live, net, urls } = setup();
    live.watchJob(JOB, vi.fn());
    net.open();

    expect(urls[0]).toContain('wss://demo.supabase.co/realtime/v1/websocket');

    const join = net.sent.find((frame) => frame.event === 'phx_join');
    expect(join).toBeDefined();
    const config = (join?.payload as { config?: { postgres_changes?: unknown[] } }).config;
    expect(config?.postgres_changes).toEqual([
      { event: '*', schema: 'public', table: 'ingest_jobs', filter: `id=eq.${JOB}` },
    ]);
  });

  it('hands over the caller access token, so RLS applies to the stream too', () => {
    const { live, net } = setup();
    live.watchJob(JOB, vi.fn());
    net.open();

    const auth = net.sent.find((frame) => frame.event === 'access_token');
    expect(auth?.payload).toEqual({ access_token: 'teacher-token' });
  });

  it('maps a pushed row into an IngestJob', () => {
    const { live, net } = setup();
    const seen: IngestJob[] = [];
    live.watchJob(JOB, (job) => seen.push(job));
    net.open();

    net.push(jobRow());

    expect(seen).toEqual([
      {
        id: JOB,
        teacherId: TEACHER,
        paperId: PAPER,
        pdfPath: 'papers/q.pdf',
        status: 'running',
        attempts: 1,
        error: null,
        questionCount: 42,
      },
    ]);
  });

  it('passes the error text through when the split failed', () => {
    const { live, net } = setup();
    const seen: IngestJob[] = [];
    live.watchJob(JOB, (job) => seen.push(job));
    net.open();

    net.push(jobRow({ status: 'failed', attempts: 3, error: 'Could not read the PDF' }));

    expect(seen[0].status).toBe('failed');
    expect(seen[0].error).toBe('Could not read the PDF');
  });

  it('ignores a frame it cannot use, instead of throwing into the page', () => {
    const { live, net } = setup();
    const onChange = vi.fn();
    live.watchJob(JOB, onChange);
    net.open();

    net.raw('not json at all');
    net.raw(JSON.stringify({ event: 'phx_reply', payload: { status: 'ok' } }));
    // A row with a status we do not know is dropped, never guessed at.
    net.push(jobRow({ status: 'splitting' }));
    net.push(jobRow({ id: null }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the socket alive with a heartbeat and no status request', () => {
    const { live, net, clock } = setup();
    live.watchJob(JOB, vi.fn());
    net.open();

    expect(clock.ticks).toHaveLength(1);
    expect(clock.ticks[0].ms).toBe(HEARTBEAT_MS);

    clock.ticks[0].fn();
    const beat = net.sent.filter((frame) => frame.event === 'heartbeat');
    expect(beat).toHaveLength(1);
    // B6: the heartbeat is NOT a status read. Nothing ever asks for the row.
    expect(beat[0].topic).toBe('phoenix');
    expect(net.sent.filter((frame) => frame.event === 'phx_join')).toHaveLength(1);
  });

  it('leaves, stops the heartbeat and closes the socket when told to stop', () => {
    const { live, net, clock } = setup();
    const stop = live.watchJob(JOB, vi.fn());
    net.open();

    stop();

    expect(net.sent.some((frame) => frame.event === 'phx_leave')).toBe(true);
    expect(clock.cleared).toBe(1);
    expect(net.closed).toBe(1);
  });

  it('is safe to stop twice, which is what React does on a fast remount', () => {
    const { live, net } = setup();
    const stop = live.watchJob(JOB, vi.fn());
    net.open();
    stop();
    stop();
    expect(net.closed).toBe(1);
  });

  it('delivers nothing after it was stopped', () => {
    const { live, net } = setup();
    const onChange = vi.fn();
    const stop = live.watchJob(JOB, onChange);
    net.open();
    stop();

    net.push(jobRow());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives a socket that drops before it ever opened', () => {
    const { live, net } = setup();
    const stop = live.watchJob(JOB, vi.fn());
    net.drop();
    expect(() => stop()).not.toThrow();
  });
});

describe('createMemoryLive (the fake every other test uses)', () => {
  it('pushes a job to the watcher and stops when told', () => {
    const { live, push, watching } = createMemoryLive();
    expect(live.isConfigured()).toBe(true);

    const seen: IngestJob[] = [];
    const stop = live.watchJob(JOB, (job) => seen.push(job));
    expect(watching()).toEqual([JOB]);

    const job: IngestJob = {
      id: JOB,
      teacherId: TEACHER,
      paperId: PAPER,
      pdfPath: 'papers/q.pdf',
      status: 'done',
      attempts: 1,
      error: null,
      questionCount: 3,
    };
    push(job);
    expect(seen).toEqual([job]);

    stop();
    expect(watching()).toEqual([]);
    push({ ...job, questionCount: 9 });
    expect(seen).toHaveLength(1);
  });

  it('only pushes to the watcher of that job id', () => {
    const { live, push } = createMemoryLive();
    const mine = vi.fn();
    live.watchJob(JOB, mine);

    push({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      teacherId: TEACHER,
      paperId: PAPER,
      pdfPath: 'papers/q.pdf',
      status: 'done',
      attempts: 1,
      error: null,
      questionCount: 1,
    });

    expect(mine).not.toHaveBeenCalled();
  });
});
