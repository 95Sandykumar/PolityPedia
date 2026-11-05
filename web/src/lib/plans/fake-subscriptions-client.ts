/**
 * The one fake `SubscriptionsClient` in the suite
 * (issue 28-plan-subscriptions).
 *
 * It lives beside the real one rather than in a test file for the same reason
 * `createFakePayments()` does: the route test, the page test and the component
 * test all need the SAME fake, and three copies of a fake drift.
 *
 * It touches no network and holds no key (web/CLAUDE.md), and it throws
 * `PurchaseError` exactly the way `createSupabaseSubscriptionsClient()` does,
 * so a test that passes here cannot pass for the wrong reason.
 */
import { PurchaseError, type PurchaseFailure } from '@/lib/purchases/types';
import type {
  Plan,
  StartedSubscription,
  SubscriptionRow,
  SubscriptionsClient,
} from './types';

/** V18's prices, so the fake quotes what Postgres would quote. */
const PRICE: Record<Plan, number> = { ai: 100, pro: 500 };

export interface FakeSubscriptionsClientOptions {
  configured?: boolean;
  /** Throw a `PurchaseError` with this code from `start()`. */
  failStart?: PurchaseFailure;
  /** Throw THIS error from `start()`, for the "not one of our codes" path. */
  failStartWith?: Error;
  /** Throw from `attachSubscriptionId()`, for the "will not stick" path. */
  failAttach?: boolean;
  /** What `list()` answers. Default: nothing stored yet. */
  rows?: readonly SubscriptionRow[];
}

export interface FakeSubscriptionsClient {
  client: SubscriptionsClient;
  /** Plans passed to `start()`, in order. Empty proves nothing was started. */
  readonly started: Plan[];
  /** Every `attachSubscriptionId()` call, in order. */
  readonly attached: { subscriptionId: string; razorpaySubscriptionId: string }[];
}

export function createFakeSubscriptionsClient(
  options: FakeSubscriptionsClientOptions = {},
): FakeSubscriptionsClient {
  const started: Plan[] = [];
  const attached: { subscriptionId: string; razorpaySubscriptionId: string }[] = [];
  const configured = options.configured ?? true;

  const client: SubscriptionsClient = {
    isConfigured() {
      return configured;
    },

    async start(plan: Plan): Promise<StartedSubscription> {
      if (options.failStartWith) throw options.failStartWith;
      if (options.failStart) throw new PurchaseError(options.failStart);
      started.push(plan);
      // Row ids count up, so a test can say `sub-row-1` without a stub library.
      return {
        subscriptionId: 'sub-row-' + started.length,
        amountInr: PRICE[plan],
        status: 'created',
      };
    },

    async attachSubscriptionId(subscriptionId: string, razorpaySubscriptionId: string) {
      if (options.failAttach) throw new PurchaseError('not_found');
      attached.push({ subscriptionId, razorpaySubscriptionId });
    },

    async list() {
      return [...(options.rows ?? [])];
    },
  };

  return { client, started, attached };
}
