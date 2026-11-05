/**
 * Supabase Realtime as a plain WebSocket, for `ai_explanations`
 * (issue 23-revision-screen).
 *
 * Design check B6: the finished explanation is PUSHED. There is no
 * `setInterval` asking Postgres "is it written yet" anywhere in this slice,
 * and the screen's test asserts that: it calls `explain` once and then only
 * the push moves the screen on.
 *
 * WHY A HAND-WRITTEN SOCKET and not `@supabase/supabase-js`: the same four
 * reasons as `questions/supabase-live.ts`, which this file deliberately
 * mirrors frame for frame. The student bundle has a 150 KB budget on 4G
 * (DESIGN.md section 10) and the SDK is a large part of that for one table
 * subscription.
 *
 * SECURITY. The token in `access_token` is the STUDENT'S own, so the server
 * only ever pushes rows `ai_explanations_select_visible` allows. There is no
 * service-role key here. Nothing in this file is logged: the frames carry a
 * token.
 *
 * The socket factory and the timer are injected, so a test can drive the whole
 * handshake with no network and no real key (web/CLAUDE.md).
 */
import { readSupabaseEnv } from '@/lib/auth/env';
import { readExplanationRow } from './explanation-row';
import { explanationKey, type ExplanationLive } from './revision-screen';
import type { Explanation, RevisionRequest } from './types';

/** Supabase hangs up after 60 s of silence. 25 s leaves room for a lost beat. */
export const HEARTBEAT_MS = 25_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of `WebSocket` this file uses. Keeps a fake tiny. */
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

export interface SupabaseExplanationLiveOptions {
  /** The caller's own Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  socketFactory?: (url: string) => LiveSocket;
  timer?: LiveTimer;
}

/**
 * The Realtime socket URL for a project. `https` becomes `wss`, so a local
 * Supabase stack works as well as the hosted one.
 */
export function realtimeUrl(url: string, anonKey: string): string {
  return `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

interface Frame {
  event?: unknown;
  payload?: unknown;
}

/** The row inside a `postgres_changes` frame, or null. */
function readPushedRow(data: unknown): unknown {
  if (typeof data !== 'string') return null;

  let frame: Frame;
  try {
    frame = JSON.parse(data) as Frame;
  } catch {
    // A frame we cannot parse is dropped. A broken push must never throw into
    // the student's screen.
    return null;
  }

  if (frame.event !== 'postgres_changes') return null;
  const payload = frame.payload as { data?: { record?: unknown } } | undefined;
  return payload?.data?.record ?? null;
}

export function createSupabaseExplanationLive(
  options: SupabaseExplanationLiveOptions = { accessToken: '' },
): ExplanationLive {
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

    watchExplanation(key: RevisionRequest, onChange: (one: Explanation) => void) {
      const noop = () => undefined;

      const found = env();
      // No keys: watch nothing rather than opening a socket that cannot work.
      if (!found) return noop;
      // The id goes straight into a Postgres filter string, so it is checked
      // against the UUID shape first.
      if (!UUID_RE.test(key.questionId)) return noop;

      const topic = `realtime:ai_explanation:${explanationKey(key.questionId, key.lang)}`;
      let ref = 0;
      const nextRef = () => String(++ref);

      let stopped = false;
      let beat: unknown = null;
      let socket: LiveSocket;

      try {
        socket = openSocket(realtimeUrl(found.url, found.anonKey));
      } catch {
        // A browser that refuses the socket leaves the screen working, with
        // the state it already has.
        return noop;
      }

      function send(event: string, payload: Record<string, unknown>, onTopic = topic) {
        if (stopped) return;
        try {
          socket.send(JSON.stringify({ topic: onTopic, event, payload, ref: nextRef() }));
        } catch {
          // The socket died between two frames. Nothing to do.
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
                table: 'ai_explanations',
                // Realtime filters on ONE column, and the primary key has
                // two, so the language is filtered below instead. RLS filters
                // the stream as well, so this is about traffic, not privacy.
                filter: `question_id=eq.${key.questionId}`,
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
        const row = readExplanationRow(readPushedRow((event as { data?: unknown })?.data));
        // A row with an unknown status is DROPPED, never guessed at, and the
        // other language's row is not this watcher's business.
        if (!row || row.lang !== key.lang) return;
        onChange(row);
      });

      return () => {
        // Guarded: React runs a cleanup twice on a fast remount, and a
        // student closing the panel must not send two leaves.
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
            JSON.stringify({ topic, event: 'phx_leave', payload: {}, ref: nextRef() }),
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
