/**
 * Server-side `ArchiveClient` over the Supabase REST API
 * (issue 45-keep-money-and-scores).
 *
 * Plain `fetch`, env read lazily, the signed-in user's own access token and no
 * service-role key: the `remove_*` / `restore_*` functions check
 * `auth.uid()` themselves and answer "not found" to a stranger.
 *
 * Security: no console call lives here, and the errors it throws carry a fixed
 * message plus a Postgres ERROR CODE or the HTTP status, never a response
 * body (a Postgres message can quote a constraint name).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  ARCHIVE_RPC,
  isRemoveResult,
  type ArchiveClient,
  type ArchiveKind,
  type RemoveResult,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The codes the functions raise -> the NAME the route switches on.
 *
 *  P0002 no_data_found                    -> not yours, or not there
 *  42501 insufficient_privilege           -> nobody signed in
 *  55000 object_not_in_prerequisite_state -> the 30 day window is over
 */
const ERRORS: Record<string, string> = {
  P0002: 'ArchiveNotFound',
  '42501': 'ArchiveNotFound',
  '55000': 'RestoreWindowOver',
};

export interface SupabaseArchiveClientOptions {
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseArchiveClient(
  options: SupabaseArchiveClientOptions,
): ArchiveClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  async function rpc(name: string, param: string, id: string): Promise<unknown> {
    const { url, anonKey } = required();
    if (!UUID_RE.test(id)) throw new Error('id must be a uuid');

    const res = await doFetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + options.accessToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ [param]: id }),
      cache: 'no-store',
    });

    if (!res.ok) {
      // The CODE only. The message beside it is prose and may quote a
      // constraint name, so it never leaves this function.
      let code = '';
      try {
        const body = (await res.json()) as { code?: unknown };
        if (typeof body?.code === 'string') code = body.code;
      } catch {
        // No JSON body: falls through to the generic error.
      }
      const named = ERRORS[code];
      if (named) throw Object.assign(new Error('archive refused'), { name: named });
      throw new Error('Supabase archive call failed with status ' + res.status);
    }

    return res.json();
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async remove(kind: ArchiveKind, id: string): Promise<RemoveResult> {
      const fn = ARCHIVE_RPC[kind];
      const body = await rpc(fn.remove, fn.param, id);
      // A text function comes back as a bare JSON string. Anything else is
      // not trusted: the screen must never say "deleted" over a guess.
      if (!isRemoveResult(body)) throw new Error('Supabase archive returned an unknown result');
      return body;
    },

    async restore(kind: ArchiveKind, id: string): Promise<void> {
      const fn = ARCHIVE_RPC[kind];
      await rpc(fn.restore, fn.param, id);
    },
  };
}
