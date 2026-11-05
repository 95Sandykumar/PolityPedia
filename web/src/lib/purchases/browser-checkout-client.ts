/**
 * The browser half of checkout (issue 26-razorpay-order-checkout).
 *
 * Three small things, none of which holds a key:
 *
 *  * `createBrowserCheckoutClient()` -- posts to our own route. The route
 *    reads the student's token out of the httpOnly session cookie, so this
 *    file never sees a token either.
 *  * `loadRazorpayCheckout()` -- injects `checkout.js` ON TAP, once. DESIGN.md
 *    section 10 caps a student page at 150 KB gzipped, and a student who never
 *    buys must not pay for the gateway bundle on every page view. It is also
 *    the reason this is a function and not a `<Script>` in the layout.
 *  * `openRazorpayCheckout()` -- builds the modal options from the order the
 *    SERVER quoted. Nothing here decides an amount.
 *
 * Security: the reply from our route carries the PUBLIC key id and an order
 * id, and that is all this file ever holds. The secret stays on the server.
 */
import {
  CHECKOUT_BRAND,
  CHECKOUT_ORDER_PATH,
  RAZORPAY_CHECKOUT_SRC,
  type BrowserCheckoutClient,
  type CheckoutOrder,
  type CheckoutStart,
} from './types';

/**
 * `--primary` from DESIGN.md section 0, as a literal.
 *
 * The one place in the app where a raw hex is right: Razorpay draws its modal
 * in its own iframe, which cannot read our CSS custom properties, so the
 * colour has to travel as a value. Change it here when the token changes.
 */
export const CHECKOUT_THEME_COLOR = '#4F46E5';

/** The id on the one script tag, so a second tap reuses it. */
const SCRIPT_ID = 'razorpay-checkout-js';

/**
 * What `new Razorpay(options).open()` needs. Razorpay's own option names.
 *
 * `order_id` and `subscription_id` are BOTH optional and exactly one is sent:
 * a one-off mock-set sale uses the order (issue 26), a monthly plan uses the
 * subscription (issue 28). `amount` goes with the order only, because a
 * subscription's price lives on the Razorpay plan object.
 */
export interface RazorpayOptions {
  key: string;
  order_id?: string;
  subscription_id?: string;
  amount?: number;
  currency: string;
  name: string;
  description?: string;
  theme?: { color: string };
  handler?: (response: Record<string, unknown>) => void;
  modal?: { ondismiss?: () => void };
}

export interface RazorpayInstance {
  open(): void;
}

export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

interface CheckoutWindow {
  Razorpay?: RazorpayConstructor;
}

export interface CheckoutScriptHost {
  doc: Document;
  win: CheckoutWindow;
}

function defaultHost(): CheckoutScriptHost {
  return { doc: document, win: window as unknown as CheckoutWindow };
}

/** A refusal from our own route, with the code the UI switches on. */
export class CheckoutRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('checkout refused: ' + code);
    this.name = 'CheckoutRequestError';
    this.code = code;
  }
}

/**
 * Load `checkout.js` and hand back the constructor.
 *
 * Already loaded -> resolves at once. Loading -> waits on the SAME tag, so two
 * fast taps make one network request and never two gateway bundles.
 */
export function loadRazorpayCheckout(
  host?: CheckoutScriptHost,
): Promise<RazorpayConstructor> {
  const { doc, win } = host ?? defaultHost();

  if (win.Razorpay) return Promise.resolve(win.Razorpay);

  return new Promise<RazorpayConstructor>((resolve, reject) => {
    const done = () => {
      if (win.Razorpay) resolve(win.Razorpay);
      else reject(new Error('Razorpay checkout loaded but is not there'));
    };

    const existing = doc.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Razorpay checkout could not load')),
        { once: true },
      );
      return;
    }

    const script = doc.createElement('script');
    script.id = SCRIPT_ID;
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.addEventListener('load', done, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Razorpay checkout could not load')),
      { once: true },
    );
    doc.head.appendChild(script);
  });
}

export interface OpenCheckoutInput {
  order: CheckoutOrder;
  /** The set title, so the modal says what is being bought. */
  description?: string;
  onPaid?: (response: Record<string, unknown>) => void;
  onDismiss?: () => void;
  host?: CheckoutScriptHost;
}

/**
 * Open the Razorpay modal for one order.
 *
 * Every number comes from `order`, which came from our server, which got it
 * from Postgres (F-G2). There is no arithmetic in this function on purpose.
 */
export async function openRazorpayCheckout({
  order,
  description,
  onPaid,
  onDismiss,
  host,
}: OpenCheckoutInput): Promise<void> {
  const Razorpay = await loadRazorpayCheckout(host ?? defaultHost());

  const checkout = new Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amountPaise,
    currency: order.currency,
    name: CHECKOUT_BRAND,
    ...(description ? { description } : {}),
    theme: { color: CHECKOUT_THEME_COLOR },
    // The handler is a HINT, not the sale. The sale is the webhook in issue
    // 27: a student who closes the tab mid-payment must still get their set,
    // and a patched handler must never open one.
    handler: (response: Record<string, unknown>) => onPaid?.(response),
    modal: { ondismiss: () => onDismiss?.() },
  });

  checkout.open();
}

/** Posts to our own route. Never holds a key, never holds a token. */
export function createBrowserCheckoutClient(fetchImpl?: typeof fetch): BrowserCheckoutClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async start({ setId, coupon }): Promise<CheckoutStart> {
      const res = await doFetch(CHECKOUT_ORDER_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No amount. There is nowhere on the server for one to be read.
        body: JSON.stringify({ set_id: setId, ...(coupon ? { coupon } : {}) }),
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

      const start = body as CheckoutStart | null;
      if (!start || typeof start !== 'object' || typeof start.free !== 'boolean') {
        throw new CheckoutRequestError('failed');
      }
      return start;
    },
  };
}
