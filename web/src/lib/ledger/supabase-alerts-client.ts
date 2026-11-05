/**
 * The admin screen's `AlertsClient` over the Supabase REST API
 * (issue 35-reconcile-visible).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the ADMIN'S OWN access token out of the
 * httpOnly session cookie. There is NO service-role key here, and that is the
 * point. The only thing that holds one is the PM2 reconcile job, which never
 * runs on Vercel. `reconcile_alerts_admin_all` in 0029 is `for all` with
 * `is_admin()` in both `using` and `with check`, so Postgres hands a teacher
 * zero rows on the read AND matches zero rows on the update.
 *
 * NO TABLE WRITE OTHER THAN `resolved_at`, and no delete at all. 0029: "An
 * alert is never deleted: that would erase the trail of a money problem."
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a PostgREST body quotes policy and constraint names, and an
 * alert body names somebody's payment).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { isUuid, type AlertsClient, type ReconcileAlertRow, type ReconcileKind } from './types';

const ALERTS = '/rest/v1/reconcile_alerts';

/** Never `select=*`, so a column added later cannot leak by accident. */
const ALERT_COLUMNS = 'id,kind,subject,order_id,expected_paise,actual_paise,created_at';

/**
 * How many open alerts the screen draws. A list longer than this is not a
 * list a human works through anyway, and the count beside the Admin link
 * already says there are more.
 */
const MAX_ALERTS = 200;

/** Same list as `reconcile_alerts_kind_check` in 0029 plus 0035. */
const KINDS: readonly ReconcileKind[] = [
  'no_purchase',
  'not_paid',
  'amount_mismatch',
  'no_payment',
  'unreadable_purchase',
];

export interface SupabaseAlertsClientOptions {
  /** The admin's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface AlertRaw {
  id?: unknown;
  kind?: unknown;
  subject?: unknown;
  order_id?: unknown;
  expected_paise?: unknown;
  actual_paise?: unknown;
  created_at?: unknown;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * A `bigint` arrives from PostgREST as a NUMBER when it fits and a STRING
 * when it does not. Both are read, and anything else becomes null, which the
 * screen draws as "no amount on this side" rather than as zero rupees.
 */
function paise(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * One alert row, or null when a field is missing or the wrong shape.
 *
 * A row we cannot read is DROPPED rather than drawn with a guess. An alert is
 * a question Boss acts on with real money, so a half-read one is worse than a
 * missing one: the missing one is still counted by the badge.
 */
function readAlertRow(raw: AlertRaw): ReconcileAlertRow | null {
  if (!isUuid(raw?.id)) return null;
  const kind = text(raw?.kind, 40);
  if (!kind || !(KINDS as readonly string[]).includes(kind)) return null;
  const subject = text(raw?.subject, 160);
  if (!subject) return null;
  const createdAtIso = text(raw?.created_at, 40);
  if (!createdAtIso) return null;
  return {
    id: raw.id,
    kind: kind as ReconcileKind,
    subject,
    orderId: text(raw?.order_id, 80),
    expectedPaise: paise(raw?.expected_paise),
    actualPaise: paise(raw?.actual_paise),
    createdAtIso,
  };
}

export function createSupabaseAlertsClient(
  options: SupabaseAlertsClientOptions,
): AlertsClient {
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
      accept: 'application/json',
      ...extra,
    };
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /**
     * The open alerts, newest first.
     *
     * A failure THROWS rather than answering an empty list. An empty list
     * reads as "nothing is wrong", and a 500 does not get to say that about
     * money.
     */
    async listOpen() {
      const { url } = required();

      const res = await doFetch(
        `${url}${ALERTS}?select=${ALERT_COLUMNS}` +
          `&resolved_at=is.null&order=created_at.desc&limit=${MAX_ALERTS}`,
        { method: 'GET', headers: headers(), cache: 'no-store' },
      );
      if (!res.ok) {
        throw new Error('Supabase alerts read failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const raw = Array.isArray(body) ? (body as AlertRaw[]) : [];
      const out: ReconcileAlertRow[] = [];
      for (const one of raw) {
        const found = readAlertRow(one);
        if (found) out.push(found);
      }
      return out;
    },

    /**
     * Set `resolved_at` on one alert that is STILL OPEN.
     *
     * `resolved_at=is.null` is in the filter and not only in the id, so two
     * admins pressing at once cannot both be told they resolved it: the second
     * update matches zero rows and answers false. Same trick as
     * `record_reconcile_alert()`'s `on conflict do nothing`.
     *
     * `return=representation` so the reply says how many rows really changed.
     * Without it PostgREST answers 204 and "did anything happen?" becomes a
     * guess.
     */
    async resolve(id: string) {
      const { url } = required();
      if (!isUuid(id)) throw new Error('an alert id must be a uuid');

      const res = await doFetch(
        `${url}${ALERTS}?id=eq.${encodeURIComponent(id)}&resolved_at=is.null&select=id`,
        {
          method: 'PATCH',
          headers: headers({ prefer: 'return=representation' }),
          body: JSON.stringify({ resolved_at: new Date().toISOString() }),
          cache: 'no-store',
        },
      );
      if (!res.ok) {
        throw new Error('Supabase alert resolve failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      return Array.isArray(body) && body.length > 0;
    },
  };
}
