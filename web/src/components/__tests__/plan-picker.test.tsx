/**
 * Me > Plans, the screen the student buys a plan on
 * (issue 28-plan-subscriptions).
 *
 * The definition of done, read off the screen:
 *
 *  * "A student opens Me > Plans, picks the AI plan (Rs 100/month) or Pro
 *    (Rs 500/month), pays through Razorpay, and gets access."
 *  * "When the subscription stops, access ends at the paid-until date."
 *
 * The subscribe client and the modal opener are both injected, so there is no
 * network call, no key and no gateway script in this file (web/CLAUDE.md).
 * `document.querySelectorAll('script')` is the proof for the bundle rule: the
 * component must not reach for `checkout.js` until the tap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PlanPicker } from '../plan-picker';
import { CheckoutRequestError } from '@/lib/purchases/browser-checkout-client';
import type { openRazorpaySubscription } from '@/lib/plans/browser-subscribe-client';
import type {
  BrowserSubscribeClient,
  Entitlement,
  Plan,
  SubscribeStart,
} from '@/lib/plans/types';

function startFor(plan: Plan): SubscribeStart {
  return {
    subscriptionId: '11111111-1111-4111-8111-111111111111',
    razorpaySubscriptionId: 'sub_test_1',
    amountInr: plan === 'ai' ? 100 : 500,
    plan,
    keyId: 'rzp_test_public',
  };
}

/**
 * The modal opener, typed as the real one. A loose `vi.fn()` would let this
 * test keep passing after the real signature changed, which is exactly the
 * kind of green a payment screen must not have.
 */
type OpenSubscription = typeof openRazorpaySubscription;

interface Harness {
  started: Plan[];
  client: BrowserSubscribeClient;
  openSubscription: Mock<OpenSubscription>;
}

function harness(options: { fail?: string } = {}): Harness {
  const started: Plan[] = [];
  const client: BrowserSubscribeClient = {
    async start(plan: Plan) {
      started.push(plan);
      if (options.fail) throw new CheckoutRequestError(options.fail);
      return startFor(plan);
    },
  };
  const openSubscription = vi.fn<OpenSubscription>(async () => undefined);
  return { started, client, openSubscription };
}

/** A live plan: paid up to a month from now. */
function live(plan: Plan): Entitlement {
  return {
    plan,
    validUntil: new Date(Date.now() + 30 * 864e5).toISOString(),
    source: 'razorpay',
  };
}

describe('the three tiers', () => {
  it('shows Free, AI Rs 100 and Pro Rs 500, in price order (V18)', () => {
    render(<PlanPicker {...harness()} />);

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Free',
      'AI plan, Rs 100 a month',
      'Pro, Rs 500 a month',
    ]);
  });

  it('gives Free no button, because there is nothing to buy', () => {
    render(<PlanPicker {...harness()} />);
    // Two buttons, not three: the free tier is the absence of a row.
    expect(screen.getAllByRole('button', { name: 'Subscribe' })).toHaveLength(2);
  });

  it('shows both languages in `both` mode', () => {
    render(<PlanPicker {...harness()} mode="both" />);
    expect(screen.getByText('प्रो, 500 रुपये महीना')).toBeTruthy();
  });
});

describe('subscribing', () => {
  it('sends the plan name and no price (F-G2), then opens Razorpay', async () => {
    const h = harness();
    render(<PlanPicker {...h} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Subscribe' })[0]);

    await waitFor(() => expect(h.openSubscription).toHaveBeenCalledTimes(1));
    // The AI card is first after Free, so the first button is the AI plan.
    expect(h.started).toEqual(['ai']);

    const opened = h.openSubscription.mock.calls[0][0];
    expect(opened.start.razorpaySubscriptionId).toBe('sub_test_1');
    expect(opened.start.keyId).toBe('rzp_test_public');
    // No amount travelled from this screen. The server quoted Rs 100.
    expect(opened.start.amountInr).toBe(100);
  });

  it('subscribes to Pro from the Pro card', async () => {
    const h = harness();
    render(<PlanPicker {...h} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Subscribe' })[1]);
    await waitFor(() => expect(h.started).toEqual(['pro']));
  });

  it('says the webhook finishes the job, never "you have Pro"', async () => {
    const h = harness();
    render(<PlanPicker {...h} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Subscribe' })[0]);
    // The month is granted by `subscription.charged`, which can land after
    // the modal closes, so the screen must not claim access by itself.
    await waitFor(() =>
      expect(
        screen.getByText('Pay in the window. Your plan starts once the payment goes through.'),
      ).toBeTruthy(),
    );
  });

  it('never subscribes twice from two taps in one tick', async () => {
    const h = harness();
    render(<PlanPicker {...h} />);

    const button = screen.getAllByRole('button', { name: 'Subscribe' })[0];
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(h.openSubscription).toHaveBeenCalledTimes(1));
    // Two subscriptions is two bills.
    expect(h.started).toEqual(['ai']);
  });

  it('loads no gateway script until the tap', async () => {
    const h = harness();
    render(<PlanPicker {...h} />);

    const before = [...document.querySelectorAll('script')].filter((s) =>
      s.src.includes('razorpay'),
    );
    expect(before).toHaveLength(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Subscribe' })[0]);
    await waitFor(() => expect(h.openSubscription).toHaveBeenCalled());

    // Still none, because the opener is injected here. The real one loads
    // `checkout.js` inside itself, which is the point: never at import time.
    const after = [...document.querySelectorAll('script')].filter((s) =>
      s.src.includes('razorpay'),
    );
    expect(after).toHaveLength(0);
  });
});

describe('a plan the student already has', () => {
  it('shows the paid-until date and no Subscribe button', () => {
    render(<PlanPicker {...harness()} entitlements={[live('ai')]} />);

    expect(screen.getByText('Your plan')).toBeTruthy();
    expect(screen.getByText(/^Paid until /)).toBeTruthy();
    // One button left: Pro. The AI card has nothing to sell.
    expect(screen.getAllByRole('button', { name: 'Subscribe' })).toHaveLength(1);
  });

  it('keeps access showing after the subscription is stopped', () => {
    // The definition of done: "When the subscription stops, access ends at the
    // paid-until date." So a cancelled subscription with a live entitlement
    // still shows its month.
    render(
      <PlanPicker
        {...harness()}
        entitlements={[live('pro')]}
        subscriptions={[{ plan: 'pro', status: 'cancelled' }]}
      />,
    );

    expect(screen.getByText('Stopped. It works until the date above.')).toBeTruthy();
    expect(screen.getByText(/^Paid until /)).toBeTruthy();
  });

  it('offers it again once the paid month is over', () => {
    const expired: Entitlement = {
      plan: 'ai',
      validUntil: new Date(Date.now() - 864e5).toISOString(),
      source: 'razorpay',
    };
    render(<PlanPicker {...harness()} entitlements={[expired]} />);

    // Expired, so no badge and the button is back.
    expect(screen.queryByText('Your plan')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Subscribe' })).toHaveLength(2);
  });
});

describe('when it goes wrong', () => {
  it('says "you already have that plan" for a 409', async () => {
    const h = harness({ fail: 'owned' });
    render(<PlanPicker {...h} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Subscribe' })[0]);
    await waitFor(() => expect(screen.getByText('You already have that plan.')).toBeTruthy());
    expect(h.openSubscription).not.toHaveBeenCalled();
  });

  it('asks an unknown code to try again, and never shows the code', async () => {
    const h = harness({ fail: 'subscriptions_rzp_idx' });
    render(<PlanPicker {...h} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Subscribe' })[0]);
    await waitFor(() =>
      expect(screen.getByText('Could not start the payment. Try again.')).toBeTruthy(),
    );
    expect(screen.queryByText(/subscriptions_rzp_idx/)).toBeNull();
  });

  it('says so and disables the buttons when nothing is set up', () => {
    render(<PlanPicker {...harness()} configured={false} />);

    expect(screen.getByText('Plans are not set up yet')).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: 'Subscribe' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
