/**
 * Server-side `SetAccessClient` over the Supabase REST API
 * (issue 16-set-access-mock-list).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so RLS decides everything:
 * `set_access_select_own` for a student and `set_access_admin_all` for a
 * grant. A student who called `grant()` from a patched build would get a 401
 * from Postgres, not a row.
 *
 * `source` is hard-wired to `admin`. Issues 19, 26 and 27 write the other two,
 * and they write them from their own code: a route that can set the source is
 * a route that can forge a purchase.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a Postgres message quotes policy and constraint names).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isAccessSource,
  isUuid,
  type GrantSetInput,
  type RevokeSetInput,
  type SetAccess,
  type SetAccessClient,
  type TestScore,
} from './types';

const ACCESS = '/rest/v1/set_access';
const ATTEMPTS = '/rest/v1/attempts';

/** Never `select=*`, so a column added later cannot leak by accident. */
const ACCESS_COLUMNS = 'set_id,source,valid_until';
const ATTEMPT_COLUMNS = 'test_id,score,submitted_at';

/** One page of tests on one screen. A set holds at most 100 of them. */
const MAX_TEST_IDS = 100;

export interface SupabaseSetAccessClientOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  /** The caller's own user id, from the session cookie. Never from a body. */
  userId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface AccessRow {
  set_id?: unknown;
  source?: unknown;
  valid_until?: unknown;
}

interface AttemptRow {
  test_id?: unknown;
  score?: unknown;
  submitted_at?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One access row, or null when any field is missing or the wrong shape. */
function readAccessRow(raw: AccessRow): SetAccess | null {
  const setId = text(raw?.set_id);
  const validUntil = text(raw?.valid_until);
  if (!setId || !validUntil) return null;
  // A source we do not know is DROPPED. It could be a column value added by a
  // later migration, and guessing that it means "paid" is how a set is given
  // away.
  if (!isAccessSource(raw.source)) return null;
  return { setId, source: raw.source, validUntil };
}

export function createSupabaseSetAccessClient(
  options: SupabaseSetAccessClientOptions,
): SetAccessClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** Any failure is an empty list, never a crash: the page still renders. */
  async function rows<T>(table: string, query: string): Promise<T[]> {
    const found = env();
    if (!found) return [];

    const res = await doFetch(`${found.url}${table}?${query}`, {
      method: 'GET',
      headers: headers({ accept: 'application/json' }),
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as T[]) : [];
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async listMine() {
      if (!isUuid(options.userId)) return [];
      // `user_id=eq.<me>` as well as the policy. Belt and braces: the filter
      // says what this read is FOR, and the policy makes it true.
      const raw = await rows<AccessRow>(
        ACCESS,
        `select=${ACCESS_COLUMNS}&user_id=eq.${encodeURIComponent(options.userId)}`,
      );
      const out: SetAccess[] = [];
      for (const one of raw) {
        const found = readAccessRow(one);
        if (found) out.push(found);
      }
      return out;
    },

    async listScores(testIds: readonly string[]) {
      if (!isUuid(options.userId)) return [];
      const ids = testIds.filter(isUuid).slice(0, MAX_TEST_IDS);
      if (ids.length === 0) return [];

      const raw = await rows<AttemptRow>(
        ATTEMPTS,
        `select=${ATTEMPT_COLUMNS}` +
          `&user_id=eq.${encodeURIComponent(options.userId)}` +
          `&test_id=in.(${ids.map(encodeURIComponent).join(',')})` +
          '&submitted_at=not.is.null&order=submitted_at.desc',
      );

      // Newest first, so the FIRST row for a test wins: the tick shows the
      // latest sitting, not a worse one from last month.
      const out: TestScore[] = [];
      const seen = new Set<string>();
      for (const one of raw) {
        const testId = text(one?.test_id);
        if (!testId || seen.has(testId)) continue;
        seen.add(testId);
        const score = typeof one.score === 'number' && Number.isFinite(one.score)
          ? one.score
          : null;
        out.push({ testId, score });
      }
      return out;
    },

    async grant({ userId, setId, validUntil }: GrantSetInput) {
      const { url } = required();
      if (!isUuid(userId)) throw new Error('user id must be a uuid');
      if (!isUuid(setId)) throw new Error('set id must be a uuid');
      if (!Number.isFinite(Date.parse(validUntil))) {
        throw new Error('valid_until must be a timestamp');
      }

      // `resolution=merge-duplicates` upserts on the primary key
      // (user_id, set_id, source), so granting the same set twice MOVES the
      // date instead of failing with a 409. Re-granting is the normal way an
      // admin extends access.
      const res = await doFetch(`${url}${ACCESS}`, {
        method: 'POST',
        headers: headers({
          accept: 'application/json',
          prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({
          user_id: userId,
          set_id: setId,
          // Fixed. A caller cannot claim this was a purchase.
          source: 'admin',
          valid_until: validUntil,
        }),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Supabase set access grant failed with status ' + res.status);
      }
    },

    async revoke({ userId, setId }: RevokeSetInput) {
      const { url } = required();
      if (!isUuid(userId)) throw new Error('user id must be a uuid');
      if (!isUuid(setId)) throw new Error('set id must be a uuid');

      // Only the hand-granted row is deleted. A purchase is not an admin's to
      // undo from this screen: refunds are issue 27's business.
      const res = await doFetch(
        `${url}${ACCESS}?user_id=eq.${encodeURIComponent(userId)}` +
          `&set_id=eq.${encodeURIComponent(setId)}&source=eq.admin`,
        {
          method: 'DELETE',
          headers: headers({ prefer: 'return=minimal' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) {
        throw new Error('Supabase set access revoke failed with status ' + res.status);
      }
    },
  };
}
