/**
 * The Unlock button, now that it takes money
 * (issue 26-razorpay-order-checkout).
 *
 * The definition of done, read off the screen:
 *
 *  * "A student taps 'Unlock Rs 399', a Razorpay order is made with the price
 *    from our database, and the Razorpay checkout opens."
 *  * "A 100% coupon opens the set at once without Razorpay."
 *  * "The Unlock button loads Razorpay checkout.js only on tap."
 *
 * The checkout client and the modal opener are both injected, so there is no
 * network call, no key and no gateway script in this file (web/CLAUDE.md).
 * `document.querySelectorAll('script')` is the proof for the third line: the
 * component must not reach for `checkout.js` until the tap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MockList } from '../mock-list';
import { CheckoutRequestError } from '@/lib/purchases/browser-checkout-client';
import { buildMockRows, type MockSetRow } from '@/lib/set-access/types';
import type { BrowserCheckoutClient, CheckoutStart } from '@/lib/purchases/types';

const TEACHER = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const TEST_1 = '33333333-3333-4333-8333-333333333333';
const TEST_2 = '44444444-4444-4444-8444-444444444444';
const PURCHASE = '55555555-5555-4555-8555-555555555555';

const PAID_ORDER: CheckoutStart = {
  free: false,
  purchaseId: PURCHASE,
  orderId: 'order_test_1',
  amountPaise: 39_900,
  currency: 'INR',
  keyId: 'rzp_test_public',
};

function rows(): MockSetRow[] {
  return buildMockRows({
    sets: [{ id: SET, title: 'UGC NET Mock Set', priceInr: 399 }],
    tests: [
      { id: TEST_1, setId: SET, title: 'Test 1', position: 1, isFreeSample: true },
      { id: TEST_2, setId: SET, title: 'Test 2', position: 2, isFreeSample: false },
    ],
    access: [],
  });
}

interface Harness {
  started: { setId: string; coupon?: string | null }[];
  opened: { orderId: string; amountPaise: number; keyId: string; description?: string }[];
  checkout: BrowserCheckoutClient;
  openCheckout: ReturnType<typeof vi.fn>;
}

function harness(answer: CheckoutStart | CheckoutRequestError): Harness {
  const started: { setId: string; coupon?: string | null }[] = [];
  const opened: Harness['opened'] = [];

  const checkout: BrowserCheckoutClient = {
    async start(input) {
      started.push(input);
      if (answer instanceof CheckoutRequestError) throw answer;
      return answer;
    },
  };

  const openCheckout = vi.fn(
    async ({
      order,
      description,
    }: {
      order: { orderId: string; amountPaise: number; keyId: string };
      description?: string;
    }) => {
      opened.push({ ...order, description });
    },
  );

  return { started, opened, checkout, openCheckout };
}

function draw(h: Harness) {
  return render(
    <MockList
      sets={rows()}
      teacherId={TEACHER}
      checkout={h.checkout}
      openCheckout={h.openCheckout as never}
    />,
  );
}

const unlock = () => screen.getByRole('button', { name: 'Unlock Rs 399' });
const coupon = () => screen.getByRole('textbox', { name: 'Coupon code (optional)' });

describe('checkout.js is not loaded until the tap', () => {
  it('puts no gateway script on the page while the list just sits there', () => {
    draw(harness(PAID_ORDER));
    const sources = Array.from(document.querySelectorAll('script')).map((one) => one.src);
    expect(sources.some((src) => src.includes('razorpay'))).toBe(false);
  });

  it('only opens the modal, which loads the script, after the tap', async () => {
    const h = harness(PAID_ORDER);
    draw(h);

    expect(h.openCheckout).not.toHaveBeenCalled();

    fireEvent.click(unlock());
    await waitFor(() => expect(h.openCheckout).toHaveBeenCalledTimes(1));
  });
});

describe('a paid set', () => {
  it('orders at the price OUR SERVER quoted and opens the modal', async () => {
    const h = harness(PAID_ORDER);
    draw(h);

    fireEvent.click(unlock());

    await waitFor(() => expect(h.opened).toHaveLength(1));
    expect(h.started).toEqual([{ setId: SET, coupon: null }]);
    expect(h.opened[0]).toMatchObject({
      orderId: 'order_test_1',
      amountPaise: 39_900,
      keyId: 'rzp_test_public',
      description: 'UGC NET Mock Set',
    });
  });

  it('says it is working while the order is being made', async () => {
    const h = harness(PAID_ORDER);
    draw(h);

    fireEvent.click(unlock());
    expect(screen.getByRole('status')).toHaveTextContent('Opening payment...');
    await waitFor(() => expect(h.opened).toHaveLength(1));
  });

  it('does not order twice when the button is tapped twice', async () => {
    const h = harness(PAID_ORDER);
    draw(h);

    fireEvent.click(unlock());
    fireEvent.click(unlock());

    await waitFor(() => expect(h.opened).toHaveLength(1));
    expect(h.started).toHaveLength(1);
  });

  it('sends the coupon the student typed, upper case', async () => {
    const h = harness(PAID_ORDER);
    draw(h);

    fireEvent.change(coupon(), { target: { value: ' half50 ' } });
    fireEvent.click(unlock());

    await waitFor(() => expect(h.started).toHaveLength(1));
    expect(h.started[0].coupon).toBe('HALF50');
  });
});

describe('a 100% coupon', () => {
  it('opens the set with no gateway modal at all', async () => {
    const h = harness({ free: true, purchaseId: PURCHASE });
    draw(h);

    fireEvent.change(coupon(), { target: { value: 'FREE100' } });
    fireEvent.click(unlock());

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Unlocked with your coupon. Reload to start.',
      ),
    );
    // THE assertion: Razorpay was never opened, so checkout.js never loaded.
    expect(h.openCheckout).not.toHaveBeenCalled();
    expect(h.started).toEqual([{ setId: SET, coupon: 'FREE100' }]);
  });
});

describe('refusals', () => {
  const cases: [string, string][] = [
    ['coupon', 'That coupon is not valid.'],
    ['owned', 'You already own this set. Reload the page.'],
    // Issue 61-block-second-order: the second tap while a payment is in flight.
    ['pending', 'A payment for this set is already in progress.'],
    ['sign_in', 'Sign in to buy this set.'],
    ['not_configured', 'Payments are not set up yet'],
    ['gateway', 'Could not start the payment. Try again.'],
    ['anything-else', 'Could not start the payment. Try again.'],
  ];

  for (const [code, sentence] of cases) {
    it(`says "${sentence}" for ${code}`, async () => {
      const h = harness(new CheckoutRequestError(code));
      draw(h);

      fireEvent.click(unlock());

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(sentence));
      expect(h.openCheckout).not.toHaveBeenCalled();
    });
  }

  it('lets the student try again after a refusal', async () => {
    const h = harness(new CheckoutRequestError('coupon'));
    draw(h);

    fireEvent.click(unlock());
    await waitFor(() => expect(h.started).toHaveLength(1));

    fireEvent.click(unlock());
    await waitFor(() => expect(h.started).toHaveLength(2));
  });
});

describe('Hindi', () => {
  it('writes the coupon box and the free message in Hindi', async () => {
    const h = harness({ free: true, purchaseId: PURCHASE });
    render(
      <MockList
        sets={rows()}
        teacherId={TEACHER}
        mode="hi"
        checkout={h.checkout}
        openCheckout={h.openCheckout as never}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'कूपन कोड (ज़रूरी नहीं)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'खोलें ₹399' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'कूपन से खुल गया। शुरू करने के लिए पेज रीलोड करें।',
      ),
    );
  });
});
