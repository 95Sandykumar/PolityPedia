/**
 * The nightly job's `ReconcileStore` over the Supabase REST API
 * (issue 29-ledger-reconcile-payouts).
 *
 * Plain `fetch` with the SERVICE-ROLE key. A cron job is not a signed-in
 * user, it carries no access token, and `record_reconcile_alert()` is granted
 * to `service_role` alone, because a student who could call it would fill
 * Boss's alert list with invented problems until the real ones are
 * unfindable.
 *
 * LAPTOP ONLY. Nothing under `src/app/` imports this file, and nothing should:
 * the reconcile is a PM2 app (D1/D2), not a route, so its service-role key
 * never ships to Vercel. The only importer is `jobs/ledger-reconcile.ts`.
 *
 * Security.
 *  * `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy in the database. It
 *    has no `NEXT_PUBLIC_` prefix, so Next.js cannot inline it into a bundle.
 *  * The env is read lazily inside every call (web/CLAUDE.md), so importing
 *    this file can never break a build with no environment variables.
 *  * No console call lives in this file, and every error it throws carries a
 *    fixed message plus the HTTP status, NEVER a response body: a PostgREST
 *    body quotes constraint names, and a 401 body can echo a token.
 */
import type { PurchaseStatus } from '@/lib/purchases/types';
import type {
  ReconcileAlertInput,
  ReconcilePurchase,
  ReconcilePurchasePage,
  ReconcileStore,
} from './types';

const PURCHASES = '/rest/v1/purchases';
const RPC = '/rest/v1/rpc/';

/** Never `select=*`, so a column added later cannot leak by accident. */
const PURCHASE_COLUMNS = 'id,razorpay_order_id,amount_inr,status';

/**
 * One night of sales. v1 sells a few sets a day, so 2,000 is far past any
 * real night; reaching it means something is wrong, and a silently truncated
 * read would turn every unseen sale into a `no_payment` alert.
 *
 * REACHING IT THROWS (issue 35-reconcile-visible). Until this issue the
 * comment above said that already and the code returned the truncated list
 * anyway, so the one night the cap mattered was the night Boss would have
 * woken up to hundreds of alerts about real, correct sales. Exported so the
 * test can build exactly `MAX_PURCHASES` rows.
 */
export const MAX_PURCHASES = 2000;

const STATUSES: readonly PurchaseStatus[] = ['created', 'paid', 'refunded'];

export interface ReconcileServiceEnv {
  /** Project URL with no trailing slash. */
  url: string;
  /** The service-role key. Bypasses RLS. Never logged, never sent onward. */
  serviceRoleKey: string;
}

/**
 * Supabase as the RECONCILE reads it.
 *
 * There is NO fallback to the anon key on purpose. The anon key cannot execute
 * `record_reconcile_alert()` and RLS would hand it zero purchases, so
 * accepting it would turn a misconfigured job into a quiet "all clear" night,
 * which is the one answer this job must never give by accident.
 */
export function readReconcileServiceEnv(
  env: Record<string, string | undefined> = process.env,
): ReconcileServiceEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

export interface SupabaseReconcileStoreOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface PurchaseRow {
  id?: unknown;
  razorpay_order_id?: unknown;
  amount_inr?: unknown;
  status?: unknown;
}

function text(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * One purchase row, or null when a field is missing or the wrong shape.
 *
 * A row we cannot read is DROPPED rather than guessed. A guessed `paid` would
 * make a real mismatch look fine, and a guessed amount would file a mismatch
 * that is not one.
 */
function readPurchaseRow(raw: PurchaseRow): ReconcilePurchase | null {
  const id = text(raw?.id);
  const status = text(raw?.status, 20);
  if (!id || !status || !(STATUSES as readonly string[]).includes(status)) return null;
  const amountInr = raw?.amount_inr;
  if (typeof amountInr !== 'number' || !Number.isFinite(amountInr) || amountInr < 0) return null;
  return {
    id,
    // NULL is normal and meaningful: the Rs 0 coupon path has no order.
    orderId: text(raw?.razorpay_order_id, 80),
    amountInr,
    status: status as PurchaseStatus,
  };
}

export function createSupabaseReconcileStore(
  options: SupabaseReconcileStoreOptions = {},
): ReconcileStore {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readReconcileServiceEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): ReconcileServiceEnv {
    const found = env();
    if (!found) throw new Error('the reconcile job is not configured');
    return found;
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const { serviceRoleKey } = required();
    return {
      apikey: serviceRoleKey,
      authorization: 'Bearer ' + serviceRoleKey,
      'content-type': 'application/json',
      ...extra,
    };
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /**
     * Our purchases in the window.
     *
     * A failure THROWS rather than answering an empty list. An empty list
     * would mean "we sold nothing", and every captured payment of the night
     * would then be filed as `no_purchase`: a quiet Supabase blip would look
     * like every student paying for nothing.
     */
    async listPurchases({ sinceIso }): Promise<ReconcilePurchasePage> {
      const { url } = required();

      const res = await doFetch(
        `${url}${PURCHASES}?select=${PURCHASE_COLUMNS}` +
          `&created_at=gte.${encodeURIComponent(sinceIso)}` +
          `&order=created_at.desc&limit=${MAX_PURCHASES}`,
        {
          method: 'GET',
          headers: headers({ accept: 'application/json' }),
          cache: 'no-store',
        },
      );
      if (!res.ok) {
        throw new Error('Supabase purchases read failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const raw = Array.isArray(body) ? (body as PurchaseRow[]) : [];

      // THE CAP, checked on the RAW rows and BEFORE parsing. Counting parsed
      // rows would let a page of junk read as a short page, and a short page
      // is what tells this function the read was complete.
      //
      // A throw and not a truncated answer: the job reports a night it could
      // not check and exits non-zero, which is the one honest answer. The
      // alternative is `no_payment` alerts about every real sale past row
      // 2,000.
      if (raw.length >= MAX_PURCHASES) {
        throw new Error(
          'Supabase purchases read hit the ' + MAX_PURCHASES + ' row cap, so it was truncated',
        );
      }

      const out: ReconcilePurchase[] = [];
      let unreadable = 0;
      for (const one of raw) {
        const found = readPurchaseRow(one);
        // Still DROPPED, never guessed. But counted now: the count files its
        // own alert, because a dropped purchase makes its captured payment
        // look like `no_purchase` (issue 35-reconcile-visible).
        if (found) out.push(found);
        else unreadable += 1;
      }
      return { purchases: out, unreadable };
    },

    /** `record_reconcile_alert()`. TRUE = new, FALSE = already on the list. */
    async recordAlert({ kind, subject, orderId, expectedPaise, actualPaise }: ReconcileAlertInput) {
      const { url } = required();
      const named = text(subject, 160);
      if (!named) throw new Error('a reconcile alert needs a subject');

      const res = await doFetch(`${url}${RPC}record_reconcile_alert`, {
        method: 'POST',
        headers: headers({ accept: 'application/json' }),
        body: JSON.stringify({
          new_kind: kind,
          new_subject: named,
          new_order_id: orderId,
          new_expected_paise: expectedPaise,
          new_actual_paise: actualPaise,
        }),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Supabase reconcile alert failed with status ' + res.status);
      }

      const answer = (await res.json()) as unknown;
      // A reply we cannot read counts as NOT NEW. Over-reporting "new" would
      // make the job's own log lie about how bad the night was; the row is
      // either there or the request failed above.
      return answer === true;
    },
  };
}
