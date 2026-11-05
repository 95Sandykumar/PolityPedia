/**
 * The browser half of checkout (issue 26-razorpay-order-checkout).
 *
 * The one the definition of done names: "The Unlock button loads Razorpay
 * checkout.js only on tap." So:
 *
 *  * nothing is in the document until `loadRazorpayCheckout()` is called,
 *  * two taps make ONE script tag,
 *  * the request body carries a set id and a coupon, and NO amount (F-G2),
 *  * a refusal keeps its code, so the list can say which sentence to show.
 *
 * `fetch` and the script host are both injected, so no network call and no
 * real key appear here (web/CLAUDE.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheckoutRequestError,
  createBrowserCheckoutClient,
  loadRazorpayCheckout,
  openRazorpayCheckout,
  type RazorpayConstructor,
  type RazorpayOptions,
} from '../browser-checkout-client';
import { RAZORPAY_CHECKOUT_SRC } from '../types';

const SET = '22222222-2222-4222-8222-222222222222';
const PURCHASE = '55555555-5555-4555-8555-555555555555';

interface FakeWindow {
  Razorpay?: RazorpayConstructor;
}

function host() {
  return { doc: document, win: {} as FakeWindow };
}

function scripts() {
  return Array.from(document.querySelectorAll('script'));
}

/** Pretend the browser finished fetching checkout.js. */
function finishLoad(win: FakeWindow, opened: RazorpayOptions[]) {
  win.Razorpay = class {
    constructor(options: RazorpayOptions) {
      opened.push(options);
    }
    open() {}
  } as unknown as RazorpayConstructor;
  for (const tag of scripts()) tag.dispatchEvent(new Event('load'));
}

beforeEach(() => {
  document.head.innerHTML = '';
});

describe('checkout.js is loaded only on tap', () => {
  it('puts nothing in the document until it is asked to', () => {
    expect(scripts()).toHaveLength(0);
  });

  it('injects one script tag and resolves when it loads', async () => {
    const h = host();
    const opened: RazorpayOptions[] = [];

    const waiting = loadRazorpayCheckout(h);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].src).toBe(RAZORPAY_CHECKOUT_SRC);
    expect(scripts()[0].async).toBe(true);

    finishLoad(h.win, opened);
    await expect(waiting).resolves.toBeTypeOf('function');
  });

  it('reuses the same tag when it is tapped twice', async () => {
    const h = host();
    const opened: RazorpayOptions[] = [];

    const first = loadRazorpayCheckout(h);
    const second = loadRazorpayCheckout(h);
    expect(scripts()).toHaveLength(1);

    finishLoad(h.win, opened);
    await Promise.all([first, second]);
    expect(scripts()).toHaveLength(1);
  });

  it('resolves at once when it is already loaded', async () => {
    const h = host();
    const opened: RazorpayOptions[] = [];
    h.win.Razorpay = class {
      constructor(options: RazorpayOptions) {
        opened.push(options);
      }
      open() {}
    } as unknown as RazorpayConstructor;

    await expect(loadRazorpayCheckout(h)).resolves.toBeTypeOf('function');
    expect(scripts()).toHaveLength(0);
  });

  it('rejects when the script cannot load', async () => {
    const h = host();
    const waiting = loadRazorpayCheckout(h);
    for (const tag of scripts()) tag.dispatchEvent(new Event('error'));
    await expect(waiting).rejects.toThrow();
  });
});

describe('the modal', () => {
  it('opens with the amount the SERVER quoted and the public key', async () => {
    const h = host();
    const opened: RazorpayOptions[] = [];
    const onPaid = vi.fn();

    const waiting = openRazorpayCheckout({
      order: {
        purchaseId: PURCHASE,
        orderId: 'order_test_1',
        amountPaise: 39_900,
        currency: 'INR',
        keyId: 'rzp_test_public',
      },
      description: 'UGC NET Mock Set',
      onPaid,
      host: h,
    });

    finishLoad(h.win, opened);
    await waiting;

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      key: 'rzp_test_public',
      order_id: 'order_test_1',
      amount: 39_900,
      currency: 'INR',
      name: 'PolityPedia',
      description: 'UGC NET Mock Set',
    });
  });
});

describe('the request', () => {
  function recorder(reply: unknown, ok = true, status = 200) {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return {
        ok,
        status,
        async json() {
          return reply;
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  it('sends the set id and the coupon, and no amount', async () => {
    const { bodies, fetchImpl } = recorder({ free: true, purchaseId: PURCHASE });

    const start = await createBrowserCheckoutClient(fetchImpl).start({
      setId: SET,
      coupon: 'FREE100',
    });

    expect(start).toEqual({ free: true, purchaseId: PURCHASE });
    expect(JSON.parse(bodies[0])).toEqual({ set_id: SET, coupon: 'FREE100' });
  });

  it('leaves the coupon out when there is none', async () => {
    const { bodies, fetchImpl } = recorder({ free: true, purchaseId: PURCHASE });
    await createBrowserCheckoutClient(fetchImpl).start({ setId: SET });
    expect(JSON.parse(bodies[0])).toEqual({ set_id: SET });
  });

  it('keeps the code from a refusal', async () => {
    const { fetchImpl } = recorder({ error: 'coupon' }, false, 422);
    await expect(
      createBrowserCheckoutClient(fetchImpl).start({ setId: SET, coupon: 'NOPE' }),
    ).rejects.toMatchObject({ code: 'coupon' });
  });

  it('reads an unreadable reply as a failure', async () => {
    const { fetchImpl } = recorder({ nothing: true });
    await expect(
      createBrowserCheckoutClient(fetchImpl).start({ setId: SET }),
    ).rejects.toBeInstanceOf(CheckoutRequestError);
  });
});
