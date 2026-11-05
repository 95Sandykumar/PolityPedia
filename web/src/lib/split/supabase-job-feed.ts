/**
 * "A split job just arrived", over Supabase Realtime
 * (issue 12-pdf-split-worker).
 *
 * design.md P9: "P9 listens on Realtime for new rows (sweep every 5 min as
 * fallback)". Design check B6 is why: a teacher waiting on the review screen
 * must not sit through up to 5 minutes of nothing, so the insert PUSHES the
 * worker awake.
 *
 * It is the same hand-written Phoenix channel as `questions/supabase-live.ts`,
 * and it reuses that file's socket types, timer and URL builder rather than
 * copying them. Two differences:
 *
 *  * It listens for INSERT on the whole table, not one row by id, because the
 *    worker wants to know about every teacher's jobs.
 *  * It carries the SERVICE-ROLE key, so RLS does not filter the stream. That
 *    is the point: `ingest_jobs_select_own` would hand a user only their own
 *    rows, and the worker is not a user.
 *
 * THE PAYLOAD IS THROWN AWAY. `onJob` takes no argument: the worker always
 * re-reads the queue with `claim_ingest_job()`, so a dropped frame costs 5
 * minutes and a duplicated frame costs nothing. A worker that trusted the
 * frame could split a row somebody else already claimed.
 *
 * Laptop only, like every other reader of the service-role key. Nothing under
 * `src/app/` imports this file.
 */
import {
  realtimeUrl,
  type LiveSocket,
  type LiveTimer,
} from '@/lib/questions/supabase-live';
import { readServiceEnv } from './env';
import type { JobFeed } from './types';

/** Supabase hangs up after 60 s of silence. Same 25 s beat as the UI socket. */
export const FEED_HEARTBEAT_MS = 25_000;

export interface SupabaseJobFeedOptions {
  env?: Record<string, string | undefined>;
  socketFactory?: (url: string) => LiveSocket;
  timer?: LiveTimer;
}

interface Frame {
  event?: unknown;
  payload?: unknown;
}

/** True for a frame that says "a row was inserted into ingest_jobs". */
export function isJobInsert(data: unknown): boolean {
  if (typeof data !== 'string') return false;

  let frame: Frame;
  try {
    frame = JSON.parse(data) as Frame;
  } catch {
    // A frame we cannot parse is dropped. The sweep is the backstop.
    return false;
  }

  if (frame.event !== 'postgres_changes') return false;
  const payload = frame.payload as { data?: { type?: unknown; table?: unknown } } | undefined;
  return payload?.data?.type === 'INSERT' && payload?.data?.table === 'ingest_jobs';
}

export function createSupabaseJobFeed(options: SupabaseJobFeedOptions = {}): JobFeed {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readServiceEnv(options.env ?? process.env);

  const openSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as LiveSocket);

  const timer: LiveTimer =
    options.timer ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };

  return {
    isConfigured() {
      return env() !== null;
    },

    watchNewJobs(onJob: () => void) {
      const noop = () => undefined;

      const found = env();
      // No keys: watch nothing. The sweep still runs, so the worker works,
      // just 5 minutes slower.
      if (!found) return noop;

      const topic = 'realtime:split_jobs';
      let ref = 0;
      let stopped = false;
      let beat: unknown = null;
      let socket: LiveSocket;

      try {
        socket = openSocket(realtimeUrl(found.url, found.serviceRoleKey));
      } catch {
        // A refused socket leaves the worker on the sweep alone, which is the
        // documented fallback, so this is not an error worth crashing for.
        return noop;
      }

      function send(event: string, payload: Record<string, unknown>, onTopic = topic) {
        if (stopped) return;
        try {
          socket.send(JSON.stringify({ topic: onTopic, event, payload, ref: String(++ref) }));
        } catch {
          // The socket died between two frames. The sweep covers it.
        }
      }

      socket.addEventListener('open', () => {
        if (stopped) return;

        send('phx_join', {
          config: {
            postgres_changes: [
              // INSERT only. The worker does not care that a teacher changed a
              // row; it cares that there is new work.
              { event: 'INSERT', schema: 'public', table: 'ingest_jobs' },
            ],
          },
        });

        // After the join, so the channel exists when the token arrives.
        send('access_token', { access_token: found.serviceRoleKey });

        beat = timer.set(() => send('heartbeat', {}, 'phoenix'), FEED_HEARTBEAT_MS);
      });

      socket.addEventListener('message', (event: unknown) => {
        if (stopped) return;
        if (isJobInsert((event as { data?: unknown })?.data)) onJob();
      });

      return () => {
        // Guarded: PM2 can send two signals in a row.
        if (stopped) return;
        stopped = true;

        if (beat !== null) {
          timer.clear(beat);
          beat = null;
        }

        try {
          // `stopped` is already true, so `send` would no-op: write the leave
          // frame directly.
          socket.send(
            JSON.stringify({ topic, event: 'phx_leave', payload: {}, ref: String(++ref) }),
          );
        } catch {
          // Already gone. Closing below is still correct.
        }
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      };
    },
  };
}

/**
 * An in-memory JobFeed. Tests and a dev run with no keys.
 *
 * `push` is synchronous, so a test can push and then await the runner's
 * `idle()` with no fake timers.
 */
export interface MemoryJobFeed {
  feed: JobFeed;
  /** Pretend a job row was inserted. */
  push(): void;
  /** How many watchers are listening. Lets a test prove `stop()` works. */
  watchers(): number;
}

export function createMemoryJobFeed(): MemoryJobFeed {
  const listeners = new Set<() => void>();

  return {
    feed: {
      isConfigured() {
        return true;
      },
      watchNewJobs(onJob: () => void) {
        listeners.add(onJob);
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          listeners.delete(onJob);
        };
      },
    },

    push() {
      // A copy of the set: a listener that stops itself inside its own
      // callback must not break the loop.
      for (const fn of [...listeners]) fn();
    },

    watchers() {
      return listeners.size;
    },
  };
}
