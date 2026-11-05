/**
 * Server-side PlansClient over the Supabase REST API (issue 21-plans-entitlements).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build that has no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: the client carries the SIGNED-IN ADMIN'S OWN access token, so
 * every write is checked by the `entitlements_admin_all` RLS policy inside
 * Postgres. There is no service-role key here, so a bug in a route handler
 * cannot hand a student the power to grant themselves Pro.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry only a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isFeature,
  isPlan,
  type EndInput,
  type Entitlement,
  type EntitlementSource,
  type Feature,
  type GrantInput,
  type PlansClient,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = '/rest/v1/entitlements';

export interface SupabasePlansClientOptions {
  /** The admin's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface StoredRow {
  plan?: unknown;
  valid_until?: unknown;
  source?: unknown;
}

function isSource(value: unknown): value is EntitlementSource {
  return value === 'admin' || value === 'razorpay';
}

export function createSupabasePlansClient(options: SupabasePlansClientOptions): PlansClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /** Same headers on every call: the project key plus the admin's token. */
  function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  function assertUserId(userId: string): void {
    if (!UUID_RE.test(userId)) throw new Error('user id must be a uuid');
  }

  /** ISO timestamp check. Done here so a bad value never reaches Postgres. */
  function assertValidUntil(validUntil: string): void {
    if (!Number.isFinite(Date.parse(validUntil))) {
      throw new Error('valid_until must be a date');
    }
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async grant({ userId, plan, validUntil }: GrantInput) {
      if (!isPlan(plan)) throw new Error('plan must be ai or pro');
      assertUserId(userId);
      assertValidUntil(validUntil);

      const { url } = required();
      const res = await doFetch(url + TABLE, {
        method: 'POST',
        // merge-duplicates makes this an upsert on the (user_id, plan) primary
        // key, so re-granting a plan moves valid_until instead of failing.
        headers: restHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
          user_id: userId,
          plan,
          valid_until: validUntil,
          source: 'admin',
        }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Supabase grant failed with status ' + res.status);
    },

    async end({ userId, plan }: EndInput) {
      if (!isPlan(plan)) throw new Error('plan must be ai or pro');
      assertUserId(userId);

      const { url } = required();
      const res = await doFetch(
        `${url}${TABLE}?user_id=eq.${encodeURIComponent(userId)}&plan=eq.${plan}`,
        { method: 'DELETE', headers: restHeaders({ prefer: 'return=minimal' }), cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Supabase end failed with status ' + res.status);
    },

    async list(userId: string) {
      if (!UUID_RE.test(userId)) return [];
      const found = env();
      if (!found) return [];

      const res = await doFetch(
        `${found.url}${TABLE}?select=plan,valid_until,source&user_id=eq.${encodeURIComponent(userId)}`,
        { method: 'GET', headers: restHeaders({ accept: 'application/json' }), cache: 'no-store' },
      );
      // A read failure is not worth crashing an admin page over: show nothing.
      if (!res.ok) return [];

      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];

      const rows: Entitlement[] = [];
      for (const raw of body as StoredRow[]) {
        // Never trust a stored plan name we do not know: skip it.
        if (!isPlan(raw.plan) || typeof raw.valid_until !== 'string' || !isSource(raw.source)) {
          continue;
        }
        rows.push({ plan: raw.plan, validUntil: raw.valid_until, source: raw.source });
      }
      return rows;
    },

    async canUse(userId: string, feature: Feature) {
      // Fail closed on anything odd, exactly like the SQL `else false` branch.
      if (!isFeature(feature) || !UUID_RE.test(userId)) return false;
      const found = env();
      if (!found) return false;

      const res = await doFetch(found.url + '/rest/v1/rpc/can_use', {
        method: 'POST',
        headers: restHeaders(),
        body: JSON.stringify({ user_id: userId, feature }),
        cache: 'no-store',
      });
      if (!res.ok) return false;
      return ((await res.json()) as unknown) === true;
    },
  };
}
