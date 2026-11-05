/**
 * The webhook's `WebhookStore` over the Supabase REST API
 * (issue 27-razorpay-webhook-ledger).
 *
 * Plain `fetch` with the SERVICE-ROLE key. That is right here and almost
 * nowhere else: a webhook is not a signed-in user, it carries no access token,
 * and the four functions in `0027_ledger.sql` are deliberately granted to
 * `service_role` alone, because granting them to `authenticated` would let any
 * student call `grant_purchase()` and open a mock set for nothing.
 *
 * WHY THIS FILE AND NOT `src/lib/split/env.ts`. That file reads the same two
 * variables, but its own header says "LAPTOP ONLY ... nothing under
 * `src/app/` imports this file", and that sentence is load-bearing: it is how
 * a reader knows the split worker's key never ships in a Vercel route. This
 * route DOES run on Vercel, so it gets its own three-line reader rather than
 * quietly making that promise false.
 *
 * Security.
 *  * `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy in the database. It
 *    has no `NEXT_PUBLIC_` prefix, so Next.js cannot inline it into a bundle,
 *    and this file is imported by exactly one route handler.
 *  * The env is read lazily inside every call (web/CLAUDE.md), so importing
 *    this file can never break a build with no environment variables.
 *  * No console call lives in this file, and every error it throws carries a
 *    fixed message plus the HTTP status, NEVER a response body: a PostgREST
 *    body quotes constraint names, and a 401 body can echo a token.
 */
import type { RecordEventInput, WebhookStore } from './webhook';

const RPC = '/rest/v1/rpc/';

/** A gateway fee bigger than this is a bug, not a fee. */
const MAX_FEE_INR = 100_000;

export interface WebhookServiceEnv {
  /** Project URL with no trailing slash. */
  url: string;
  /** The service-role key. Bypasses RLS. Never logged, never sent onward. */
  serviceRoleKey: string;
}

/**
 * Supabase as the WEBHOOK reads it.
 *
 * There is NO fallback to the anon key on purpose. The anon key cannot execute
 * any of 0027's functions, so accepting it would turn every webhook into a
 * silent 500 instead of a loud "not configured" the route can answer with.
 */
export function readWebhookServiceEnv(
  env: Record<string, string | undefined> = process.env,
): WebhookServiceEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

export interface SupabaseWebhookStoreOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * A short id on its way into a request body. The two lengths match the CHECK
 * constraints in 0027 (`purchases.razorpay_order_id` 80,
 * `payment_events.event_id` 120), so a value Postgres would refuse is refused
 * here instead of costing a round trip.
 */
function shortId(value: string, what: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new Error('the webhook needs a ' + what);
  }
  return trimmed;
}

/** Rupees to the paisa, and nothing strange. */
function fee(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_FEE_INR) {
    throw new Error('the gateway fee must be a sane number of rupees');
  }
  return Math.round(value * 100) / 100;
}

export function createSupabaseWebhookStore(
  options: SupabaseWebhookStoreOptions = {},
): WebhookStore {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readWebhookServiceEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): WebhookServiceEnv {
    const found = env();
    if (!found) throw new Error('the Razorpay webhook store is not configured');
    return found;
  }

  /**
   * One RPC call. Throws on anything that is not 2xx, which is what makes
   * `handleRazorpayWebhook()` answer 500 and Razorpay deliver again.
   *
   * The key goes in BOTH headers, which is what PostgREST wants: `apikey` for
   * the gateway and `authorization` for the role.
   */
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, serviceRoleKey } = required();

    const res = await doFetch(url + RPC + name, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: 'Bearer ' + serviceRoleKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
    });

    if (!res.ok) {
      // The status and nothing else. See the security note in the header.
      throw new Error(name + ' failed with status ' + res.status);
    }

    const text = await res.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(name + ' reply could not be read');
    }
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async recordEvent({ eventId, type, payload }: RecordEventInput) {
      const answer = await rpc('record_payment_event', {
        new_event_id: shortId(eventId, 'event id', 120),
        new_type: type,
        new_payload: payload ?? {},
      });

      // FAIL CLOSED. A shape we cannot read must not be assumed `true`:
      // "new" sends the event on to the grant with no de-dupe behind it, and
      // that is how a teacher gets paid twice for one sale.
      if (typeof answer !== 'boolean') {
        throw new Error('record_payment_event reply could not be read');
      }
      return answer;
    },

    async forgetEvent(eventId: string) {
      await rpc('forget_payment_event', { new_event_id: shortId(eventId, 'event id', 120) });
    },

    async grantPurchase({ orderId: order, feeInr }) {
      // The answer is thrown away ON PURPOSE. `false` means "already paid" or
      // "not an order of ours", and both are normal: Razorpay gets its 2xx
      // and nothing is retried. Only an HTTP failure is worth a retry, and
      // `rpc()` has already thrown for that.
      await rpc('grant_purchase', { order_id: shortId(order, 'order id', 80), fee: fee(feeInr) });
    },

    async refundPurchase({ orderId: order }) {
      await rpc('refund_purchase', { order_id: shortId(order, 'order id', 80) });
    },
  };
}
