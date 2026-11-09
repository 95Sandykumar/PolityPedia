/**
 * Server-side `CheckoutClient` over the Supabase REST API
 * (issue 26-razorpay-order-checkout).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN STUDENT'S own access token.
 * There is no service-role key here. Both functions are SECURITY DEFINER and
 * take their buyer from `auth.uid()`, so the token IS the identity: a token
 * for student A can never buy for student B, whatever this file sends.
 *
 * Only two calls exist, and neither has an amount: `start_set_purchase()`
 * reads the price from `mock_sets` itself (F-G2).
 *
 * Security: tokens are secrets. No console call lives in this file. A refusal
 * becomes a `PurchaseError` carrying only our own code, taken from the
 * SQLSTATE; the PostgREST message is dropped, because it quotes constraint
 * and policy names.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isUuid,
  purchaseFailureFrom,
  readPendingOrderId,
  PurchaseError,
  type CheckoutClient,
  type StartPurchaseInput,
  type StartedPurchase,
} from './types';

const RPC = '/rest/v1/rpc/';

/** `purchases.status`, as PostgREST sends it back from the function. */
const STATUSES = new Set(['created', 'paid', 'refunded']);

export interface SupabaseCheckoutClientOptions {
  /** The student's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface StartedRow {
  purchase_id?: unknown;
  amount_inr?: unknown;
  status?: unknown;
}

/**
 * `returns table (...)` comes back as an ARRAY of one row through PostgREST,
 * so the first row is the answer. A `returns setof` with no rows would be an
 * empty array, which is a failure and not a free set.
 */
function readStarted(body: unknown): StartedPurchase | null {
  const row = (Array.isArray(body) ? body[0] : body) as StartedRow | undefined;
  if (typeof row !== 'object' || row === null) return null;

  const purchaseId = row.purchase_id;
  const amount = row.amount_inr;
  const status = row.status;

  if (!isUuid(purchaseId)) return null;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;

  return { purchaseId, amountInr: amount, status: status as StartedPurchase['status'] };
}

export function createSupabaseCheckoutClient(
  options: SupabaseCheckoutClientOptions,
): CheckoutClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new PurchaseError('failed');
    return found;
  }

  /**
   * One RPC call. A non-2xx answer is turned into a `PurchaseError` whose
   * code comes from the SQLSTATE the function raised, so the UI can say
   * "already unlocked" rather than "something went wrong".
   */
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, anonKey } = required();

    const res = await doFetch(url + RPC + name, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + options.accessToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
    });

    if (!res.ok) {
      let sqlstate: unknown = null;
      let details: unknown = null;
      try {
        const problem = (await res.json()) as { code?: unknown; details?: unknown };
        sqlstate = problem?.code;
        details = problem?.details;
      } catch {
        // No JSON body: `purchaseFailureFrom` reads that as `failed`.
      }
      // `details` is the ONE Postgres field besides the SQLSTATE that is read
      // here, and only a string shaped like a Razorpay order id survives
      // `readPendingOrderId` (issue 61-block-second-order). The message is
      // still dropped: it quotes constraint and policy names.
      throw new PurchaseError(purchaseFailureFrom(sqlstate), readPendingOrderId(details));
    }

    // A 204 has no body. `text()` first, so a bare success does not throw.
    const text = await res.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PurchaseError('failed');
    }
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async start({ setId, coupon }: StartPurchaseInput) {
      if (!isUuid(setId)) throw new PurchaseError('not_found');

      const body = await rpc('start_set_purchase', {
        for_set: setId,
        // `null` and not an empty string: `start_set_purchase()` treats both
        // the same, and null is what "no coupon" means.
        coupon_code: coupon ?? null,
      });

      const started = readStarted(body);
      // A shape we cannot read fails CLOSED. Reading it as free would hand
      // the set away; reading it as paid-and-created would charge for an
      // order that does not exist.
      if (!started) throw new PurchaseError('failed');
      return started;
    },

    async attachOrderId(purchaseId: string, orderId: string) {
      if (!isUuid(purchaseId)) throw new PurchaseError('not_found');
      await rpc('attach_order_id', { purchase: purchaseId, order_id: orderId });
    },
  };
}
