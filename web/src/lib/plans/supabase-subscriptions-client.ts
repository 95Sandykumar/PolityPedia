/**
 * Server-side `SubscriptionsClient` over the Supabase REST API
 * (issue 28-plan-subscriptions).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN STUDENT'S own access token.
 * There is no service-role key here. Both functions are SECURITY DEFINER and
 * take their buyer from `auth.uid()`, so the token IS the identity: a token
 * for student A can never subscribe for student B, whatever this file sends.
 * The two functions that DO need the service role, `charge_subscription()`
 * and `mark_subscription()`, live in `@/lib/purchases/supabase-webhook-store`
 * and are reachable from exactly one route.
 *
 * Only two calls exist, and neither has an amount: `start_plan_subscription()`
 * reads the price from `plan_price_inr()` itself (F-G2).
 *
 * Security: tokens are secrets. No console call lives in this file. A refusal
 * becomes a `PurchaseError` carrying only our own code, taken from the
 * SQLSTATE; the PostgREST message is dropped, because it quotes constraint
 * and policy names.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { isUuid, purchaseFailureFrom, PurchaseError } from '@/lib/purchases/types';
import {
  isPlan,
  type Plan,
  type StartedSubscription,
  type SubscriptionRow,
  type SubscriptionStatus,
  type SubscriptionsClient,
} from './types';

const RPC = '/rest/v1/rpc/';
const TABLE = '/rest/v1/subscriptions';

/** `subscriptions.status`, as PostgREST sends it back from the function. */
const STATUSES = new Set<string>(['created', 'active', 'cancelled', 'halted']);

/** Same ceiling as `subscriptions_rzp_check` in 0028. */
const MAX_RZP_ID = 80;

export interface SupabaseSubscriptionsClientOptions {
  /** The student's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface StartedRow {
  subscription_id?: unknown;
  amount_inr?: unknown;
  status?: unknown;
}

/**
 * `returns table (...)` comes back as an ARRAY of one row through PostgREST,
 * so the first row is the answer. An empty array is a failure and never a
 * free plan.
 */
function readStarted(body: unknown): StartedSubscription | null {
  const row = (Array.isArray(body) ? body[0] : body) as StartedRow | undefined;
  if (typeof row !== 'object' || row === null) return null;

  const subscriptionId = row.subscription_id;
  const amount = row.amount_inr;
  const status = row.status;

  if (!isUuid(subscriptionId)) return null;
  // Must be a REAL price. A zero would be a free Pro plan, and 0028's
  // `subscriptions_amount_check` already refuses to store one.
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;

  return {
    subscriptionId,
    amountInr: amount,
    status: status as SubscriptionStatus,
  };
}

export function createSupabaseSubscriptionsClient(
  options: SupabaseSubscriptionsClientOptions,
): SubscriptionsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new PurchaseError('failed');
    return found;
  }

  /**
   * One RPC call. A non-2xx answer is turned into a `PurchaseError` whose code
   * comes from the SQLSTATE the function raised, so the page can say "you
   * already have that plan" rather than "something went wrong".
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
      try {
        const problem = (await res.json()) as { code?: unknown };
        sqlstate = problem?.code;
      } catch {
        // No JSON body: `purchaseFailureFrom` reads that as `failed`.
      }
      throw new PurchaseError(purchaseFailureFrom(sqlstate));
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

    async start(plan: Plan) {
      // Refused here as well as in Postgres, so a typo costs no round trip.
      if (!isPlan(plan)) throw new PurchaseError('not_found');

      const started = readStarted(await rpc('start_plan_subscription', { for_plan: plan }));
      // A shape we cannot read fails CLOSED. Reading it as started would send
      // the student to pay against a row id we invented.
      if (!started) throw new PurchaseError('failed');
      return started;
    },

    async attachSubscriptionId(subscriptionId: string, razorpaySubscriptionId: string) {
      if (!isUuid(subscriptionId)) throw new PurchaseError('not_found');

      // `failed` and not a nicer code: an id this wrong came from OUR gateway
      // adapter, not from the student, and there is nothing for them to fix.
      const id = razorpaySubscriptionId.trim();
      if (id.length === 0 || id.length > MAX_RZP_ID) throw new PurchaseError('failed');

      await rpc('attach_subscription_id', {
        subscription: subscriptionId,
        subscription_id: id,
      });
    },

    /**
     * A plain SELECT, not a function, because reading is already safe:
     * `subscriptions_select_own` in 0028 limits it to `auth.uid() = user_id`,
     * so there is no filter here that a bug could widen. Only `plan` and
     * `status` are asked for: the row also holds an amount and a Razorpay id,
     * and a screen that says "Stopped" needs neither.
     *
     * EMPTY ON ANY FAILURE, never a throw. This read only decides whether a
     * card says "Stopped"; failing the whole Plans page over it would stop a
     * student subscribing because we could not draw one sentence.
     */
    async list(): Promise<SubscriptionRow[]> {
      const found = env();
      if (!found) return [];

      try {
        const res = await doFetch(
          found.url + TABLE + '?select=plan,status&order=created_at.desc',
          {
            method: 'GET',
            headers: {
              apikey: found.anonKey,
              authorization: 'Bearer ' + options.accessToken,
              accept: 'application/json',
            },
            cache: 'no-store',
          },
        );
        if (!res.ok) return [];

        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) return [];

        const out: SubscriptionRow[] = [];
        for (const raw of body) {
          const one = raw as { plan?: unknown; status?: unknown };
          // A row we cannot read is DROPPED, not guessed: an invented
          // 'active' would make a card claim a plan nobody paid for.
          if (!isPlan(one?.plan)) continue;
          if (typeof one?.status !== 'string' || !STATUSES.has(one.status)) continue;
          out.push({ plan: one.plan, status: one.status as SubscriptionStatus });
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}
