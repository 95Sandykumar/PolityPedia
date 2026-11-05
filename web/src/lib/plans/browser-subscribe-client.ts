/**
 * The browser half of subscribing to a plan (issue 28-plan-subscriptions).
 *
 * Two small things, neither of which holds a key:
 *
 *  * `createBrowserSubscribeClient()` -- posts to our own route. The route
 *    reads the student's token out of the httpOnly session cookie, so this
 *    file never sees a token either.
 *  * `openRazorpaySubscription()` -- opens the gateway modal for a
 *    SUBSCRIPTION. It reuses `loadRazorpayCheckout()` from issue 26, so
 *    `checkout.js` is still injected ON TAP and only once: DESIGN.md section
 *    10 caps a student page at 150 KB gzipped, and a student who never
 *    subscribes must not carry a gateway bundle on every page view.
 *
 * `subscription_id` AND NOT `order_id`. Razorpay's modal takes one or the
 * other, and a subscription has no order: the order ids Razorpay makes per
 * cycle belong to it, not to our `purchases` table. Sending one as `order_id`
 * is how a plan would end up hunting for a mock-set purchase.
 *
 * Security: the reply from our route carries the PUBLIC key id and a
 * subscription id, and that is all this file ever holds. The secret stays on
 * the server.
 */
import {
  CHECKOUT_THEME_COLOR,
  loadRazorpayCheckout,
  CheckoutRequestError,
  type CheckoutScriptHost,
} from '@/lib/purchases/browser-checkout-client';
import { CHECKOUT_BRAND, CHECKOUT_SUBSCRIPTION_PATH } from '@/lib/purchases/types';
import type { BrowserSubscribeClient, Plan, SubscribeStart } from './types';

export interface OpenSubscriptionInput {
  start: SubscribeStart;
  /** The plan name as the student reads it, so the modal says what this is. */
  description?: string;
  onPaid?: (response: Record<string, unknown>) => void;
  onDismiss?: () => void;
  host?: CheckoutScriptHost;
}

/**
 * Open the Razorpay modal for one subscription.
 *
 * There is no amount in these options ON PURPOSE. A subscription is billed
 * against the Razorpay PLAN object, which holds the price in Razorpay's own
 * console, so there is no number here for a patched browser to change.
 */
export async function openRazorpaySubscription({
  start,
  description,
  onPaid,
  onDismiss,
  host,
}: OpenSubscriptionInput): Promise<void> {
  const Razorpay = await loadRazorpayCheckout(host);

  const checkout = new Razorpay({
    key: start.keyId,
    subscription_id: start.razorpaySubscriptionId,
    currency: 'INR',
    name: CHECKOUT_BRAND,
    ...(description ? { description } : {}),
    theme: { color: CHECKOUT_THEME_COLOR },
    // The handler is a HINT, not the plan. The month is granted by
    // `subscription.charged` in the webhook: a student who closes the tab
    // mid-payment must still get their month, and a patched handler must never
    // hand out one.
    handler: (response: Record<string, unknown>) => onPaid?.(response),
    modal: { ondismiss: () => onDismiss?.() },
  });

  checkout.open();
}

/** Posts to our own route. Never holds a key, never holds a token. */
export function createBrowserSubscribeClient(fetchImpl?: typeof fetch): BrowserSubscribeClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async start(plan: Plan): Promise<SubscribeStart> {
      const res = await doFetch(CHECKOUT_SUBSCRIPTION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No amount. There is nowhere on the server for one to be read.
        body: JSON.stringify({ plan }),
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Left null: an unreadable reply is a failure below.
      }

      if (!res.ok) {
        const code = (body as { error?: unknown })?.error;
        throw new CheckoutRequestError(typeof code === 'string' ? code : 'failed');
      }

      const start = body as SubscribeStart | null;
      if (
        !start ||
        typeof start !== 'object' ||
        typeof start.razorpaySubscriptionId !== 'string' ||
        typeof start.keyId !== 'string'
      ) {
        throw new CheckoutRequestError('failed');
      }
      return start;
    },
  };
}
