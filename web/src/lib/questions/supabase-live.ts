/**
 * Supabase Realtime as a plain WebSocket (issue 11-ingest-job-review-publish).
 *
 * Design check B6: the split job status is PUSHED. There is no `setInterval`
 * asking Postgres "is it done yet" anywhere in this slice, and the test for
 * this file asserts that: the only timer is the Phoenix heartbeat, which keeps
 * the socket open and never reads a row.
 *
 * WHY A HAND-WRITTEN SOCKET and not `@supabase/supabase-js`: the whole student
 * bundle has a 150 KB budget on 4G (DESIGN.md section 10), the SDK is a large
 * part of that for one table subscription, and this app already talks to
 * Supabase over plain `fetch` everywhere else. Realtime speaks the Phoenix
 * channel protocol, which is four JSON frames:
 *
 *   phx_join      -> "push me changes of table X where id = Y"
 *   access_token  -> the CALLER's own token, so RLS filters the stream too
 *   heartbeat     -> every 25 s on the `phoenix` topic, or the server hangs up
 *   phx_leave     -> stop
 *
 * SECURITY. The token in `access_token` is the teacher's own, so the server
 * only ever pushes rows the `ingest_jobs_select_own` policy allows. There is
 * no service-role key here. Nothing in this file is logged: the frames carry a
 * token.
 *
 * The socket factory and the timer are injected, so the test drives the whole
 * handshake with no network and no real key (web/CLAUDE.md).
 */
import { readSupabaseEnv } from '@/lib/auth/env';
import { readJobRow, type JobRow } from './rows';
import type { IngestJob, Live } from './types';

/**
 * Supabase hangs up after 60 s of silence. 25 s leaves room for one lost beat
 * on a 4G connection that drops.
 */
export const HEARTBEAT_MS = 25_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of `WebSocket` this file uses. Keeps the fake in tests tiny. */
export interface LiveSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** `setInterval` / `clearInterval`, injected so a test can run the beat. */
export interface LiveTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SupabaseLiveOptions {
  /** The caller's own Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  socketFactory?: (url: string) => LiveSocket;
  timer?: LiveTimer;
}

/**
 * The Realtime socket URL for a project.
 *
 * `https` becomes `wss` and `http` becomes `ws`, so a local Supabase stack
 * works as well as the hosted one. The key is escaped because it lands in a
 * query string.
 */
export function realtimeUrl(url: string, anonKey: string): string {
  const base = url.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

interface Frame {
  topic?: unknown;
  event?: unknown;
  payload?: unknown;
}

/** The row inside a `postgres_changes` frame, or null. */
function readPushedRow(data: unknown): JobRow | null {
  if (typeof data !== 'string') return null;

  let frame: Frame;
  try {
    frame = JSON.parse(data) as Frame;
  } catch {
    // A frame we cannot parse is dropped. A broken push must never throw into
    // the teacher's screen.
    return null;
  }

  if (frame.event !== 'postgres_changes') return null;
  const payload = frame.payload as { data?: { record?: unknown } } | undefined;
  const record = payload?.data?.record;
  if (typeof record !== 'object' || record === null) return null;
  return record as JobRow;
}

export function createSupabaseLive(options: SupabaseLiveOptions = { accessToken: '' }): Live {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);

  const openSocket =
    options.socketFactory ??
    ((url: string) => new WebSocket(url) as unknown as LiveSocket);

  const timer: LiveTimer =
    options.timer ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };

  return {
    isConfigured() {
      return env() !== null;
    },

    watchJob(jobId: string, onChange: (job: IngestJob) => void) {
      const noop = () => undefined;

      const found = env();
      // No keys: watch nothing rather than opening a socket that cannot work.
      if (!found) return noop;
      // The id goes straight into a Postgres filter string, so it is checked
      // against the UUID shape first.
      if (!UUID_RE.test(jobId)) return noop;

      const topic = `realtime:ingest_job:${jobId}`;
      let ref = 0;
      const nextRef = () => String(++ref);

      let stopped = false;
      let beat: unknown = null;
      let socket: LiveSocket;

      try {
        socket = openSocket(realtimeUrl(found.url, found.anonKey));
      } catch {
        // A browser that refuses the socket leaves the page working, with the
        // status it was server-rendered with.
        return noop;
      }

      function send(event: string, payload: Record<string, unknown>, onTopic = topic) {
        if (stopped) return;
        try {
          socket.send(JSON.stringify({ topic: onTopic, event, payload, ref: nextRef() }));
        } catch {
          // The socket died between two frames. Nothing to do: the page keeps
          // the status it already has.
        }
      }

      socket.addEventListener('open', () => {
        if (stopped) return;

        send('phx_join', {
          config: {
            postgres_changes: [
              {
                event: '*',
                schema: 'public',
                table: 'ingest_jobs',
                // RLS filters the stream as well, so this is about traffic,
                // not about privacy: one row instead of every teacher's jobs.
                filter: `id=eq.${jobId}`,
              },
            ],
          },
        });

        // After the join, so the channel exists when the token arrives.
        send('access_token', { access_token: options.accessToken });

        beat = timer.set(() => send('heartbeat', {}, 'phoenix'), HEARTBEAT_MS);
      });

      socket.addEventListener('message', (event: unknown) => {
        if (stopped) return;
        const row = readPushedRow((event as { data?: unknown })?.data);
        // A row with an unknown status is DROPPED, never guessed at (Risk 1).
        const job = readJobRow(row);
        if (job) onChange(job);
      });

      return () => {
        // Guarded: React runs a cleanup twice on a fast remount, and the
        // teacher switching tabs must not send two leaves.
        if (stopped) return;
        stopped = true;

        if (beat !== null) {
          timer.clear(beat);
          beat = null;
        }

        try {
          // `stopped` is already true, so `send` would no-op: write the leave
          // frame directly.
          socket.send(JSON.stringify({ topic, event: 'phx_leave', payload: {}, ref: nextRef() }));
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
