'use client';

/**
 * Me > Plans (issue 28-plan-subscriptions).
 *
 * The definition of done, read off the screen: "A student opens Me > Plans,
 * picks the AI plan (Rs 100/month) or Pro (Rs 500/month), pays through
 * Razorpay, and gets access. When the subscription stops, access ends at the
 * paid-until date."
 *
 * Three cards, one per V18 tier, in price order: Free, AI, Pro. Free has no
 * button, because the free tier is the ABSENCE of a row and there is nothing
 * to buy. DESIGN.md section 2: one clear action per screen, icon plus 1 to 3
 * words, no paragraphs.
 *
 * TWO RULES LIVE IN THE SUBSCRIBE BUTTON:
 *
 *  * NO PRICE IS SENT. `PLAN_PRICE_INR` is drawn on the card and nowhere else.
 *    What is charged is what `plan_price_inr()` quotes (F-G2), so a student who
 *    edits this component changes the label and not the bill.
 *  * `checkout.js` IS LOADED ON TAP, inside `openRazorpaySubscription()`,
 *    never at import time. DESIGN.md section 10 caps a student page at 150 KB
 *    gzipped, and a student who never subscribes must not carry a gateway
 *    bundle.
 *
 * WHAT THIS COMPONENT IS NOT. It is not the gate. The plan a card claims is
 * only a label; `can_use()` in `0021_entitlements.sql` is what unlocks an AI
 * explanation, and `0028_subscriptions.sql` is what moves `valid_until`. That
 * is also why a paid month does not flip this screen by itself: the month is
 * granted by `subscription.charged` in the webhook, which may land after the
 * modal closes, so the honest thing on screen is "pay in the window".
 *
 * A CANCELLED PLAN STILL SHOWS ITS DATE, on purpose. The student paid for the
 * month, so the card says "Stopped. It works until the date above" rather than
 * hiding a month they can still use.
 */
import { Check, Info, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  createBrowserSubscribeClient,
  openRazorpaySubscription as openSubscriptionDefault,
} from '@/lib/plans/browser-subscribe-client';
import {
  PLAN_PRICE_INR,
  type BrowserSubscribeClient,
  type Entitlement,
  type Plan,
  type SubscriptionRow,
} from '@/lib/plans/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** 48 px tall, the touch-target floor (DESIGN.md section 5). */
const SUBSCRIBE =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-primary px-3 text-base font-medium text-white transition-colors duration-100 disabled:opacity-60';
const BADGE =
  'inline-flex items-center gap-1 rounded-full border border-primary px-2 py-0.5 text-xs font-medium text-primary';

/**
 * What a refusal from our own route says on screen. Every code the route can
 * answer with gets a sentence of its own, because "you already have it" and
 * "sign in" ask the student to do different things. An unknown code falls back
 * to "try again": a code we do not recognise is not a code we can explain.
 */
const SUBSCRIBE_MESSAGE: Record<string, MessageKey> = {
  owned: 'mePlans.owned',
  sign_in: 'mePlans.signIn',
  not_configured: 'mePlans.notConfigured',
};

/** One client for the whole page, built on first use and never at import. */
let sharedClient: BrowserSubscribeClient | null = null;
function defaultClient(): BrowserSubscribeClient {
  sharedClient ??= createBrowserSubscribeClient();
  return sharedClient;
}

/** The three tiers, in price order. Free first, because most students are. */
const TIERS: readonly {
  plan: Plan | null;
  name: MessageKey;
  what: MessageKey;
}[] = [
  { plan: null, name: 'mePlans.free', what: 'mePlans.freeWhat' },
  { plan: 'ai', name: 'mePlans.ai', what: 'mePlans.aiWhat' },
  { plan: 'pro', name: 'mePlans.pro', what: 'mePlans.proWhat' },
];

/** What Subscribe is doing, for the one plan whose button was tapped. */
type SubscribeState =
  | { plan: Plan; kind: 'working' }
  | { plan: Plan; kind: 'started' }
  | { plan: Plan; kind: 'error'; message: MessageKey };

function Lines({ keyName, mode }: { keyName: MessageKey; mode: LangMode }) {
  return (
    <>
      {labels(keyName, mode).map((line, index) => (
        <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
          {line}
        </span>
      ))}
    </>
  );
}

/**
 * The paid-until date, in the student's own locale.
 *
 * `en-IN` for both modes on purpose: DESIGN.md section 1 says numbers are
 * always in Latin digits, and a Devanagari-digit date would break that rule on
 * the one line a student checks before they pay again.
 */
function paidUntil(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function PlanPicker({
  entitlements = [],
  subscriptions = [],
  configured = true,
  mode = DEFAULT_MODE,
  client,
  openSubscription = openSubscriptionDefault,
}: {
  /** The student's stored plans, from `entitlements`. Live or expired. */
  entitlements?: readonly Entitlement[];
  /** Their subscription rows, so a stopped plan can say so. */
  subscriptions?: readonly SubscriptionRow[];
  /** False when Supabase or Razorpay is not set up, so the page can say so. */
  configured?: boolean;
  mode?: LangMode;
  /** Injected in tests, so no request to our route is ever real. */
  client?: BrowserSubscribeClient;
  /** Injected in tests. The default is what loads `checkout.js` on tap. */
  openSubscription?: typeof openSubscriptionDefault;
}) {
  const [state, setState] = useState<SubscribeState | null>(null);
  /**
   * A ref and not the state above, because two taps inside one tick both read
   * the OLD state and would both subscribe. Two subscriptions is two bills.
   */
  const inFlight = useRef(false);

  async function subscribe(plan: Plan) {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ plan, kind: 'working' });

    try {
      // No price in this call. There is nowhere on the server for one to be
      // read, and `plan_price_inr()` is the only thing that decides the bill.
      const start = await (client ?? defaultClient()).start(plan);
      await openSubscription({ start, description: plain(TIER_NAME[plan], mode) });
      // The modal is up. Whatever happens inside it, the month is granted by
      // `subscription.charged` in the webhook, so this screen only says so.
      setState({ plan, kind: 'started' });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const message = typeof code === 'string' ? SUBSCRIBE_MESSAGE[code] : undefined;
      setState({ plan, kind: 'error', message: message ?? 'mePlans.failed' });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        <Lines keyName="mePlans.hint" mode={mode} />
      </p>

      {!configured && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-[10px] border border-marked bg-card p-3 text-sm leading-5 text-marked"
        >
          <Info aria-hidden="true" className="size-5 shrink-0" strokeWidth={2} />
          {plain('mePlans.notConfigured', mode)}
        </p>
      )}

      {TIERS.map((tier) => {
        const held = tier.plan
          ? entitlements.find((one) => one.plan === tier.plan)
          : undefined;
        const live = held ? new Date(held.validUntil).getTime() > Date.now() : false;
        const row = tier.plan
          ? subscriptions.find((one) => one.plan === tier.plan)
          : undefined;
        const busy = state?.plan === tier.plan && state.kind === 'working';

        return (
          <div key={tier.name} className={`${CARD} flex flex-col gap-2`}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-[18px] leading-6 font-bold">
                <Lines keyName={tier.name} mode={mode} />
              </h2>
              {live && (
                <span className={BADGE}>
                  <Check aria-hidden="true" className="size-4" />
                  {plain('mePlans.yours', mode)}
                </span>
              )}
            </div>

            <p className="text-sm text-muted-foreground">
              <Lines keyName={tier.what} mode={mode} />
            </p>

            {/* The paid-until date. Tabular, like every number on a price. */}
            {held && live && (
              <p className="text-sm tabular-nums">
                {plain('mePlans.paidUntil', mode)} {paidUntil(held.validUntil)}
              </p>
            )}

            {/* A stopped plan still shows its month. See the header. */}
            {live && row?.status === 'cancelled' && (
              <p role="status" className="text-sm text-muted-foreground">
                {plain('mePlans.stopped', mode)}
              </p>
            )}

            {/* Free has no button: there is nothing to buy. */}
            {tier.plan && !live && (
              <button
                type="button"
                className={SUBSCRIBE}
                disabled={!configured || busy}
                aria-label={plain('mePlans.subscribe', mode)}
                onClick={() => subscribe(tier.plan as Plan)}
              >
                <Sparkles aria-hidden="true" className="size-5" />
                {busy ? plain('mePlans.opening', mode) : plain('mePlans.subscribe', mode)}
              </button>
            )}

            {state?.plan === tier.plan && state.kind === 'started' && (
              <p role="status" className="text-sm">
                {plain('mePlans.started', mode)}
              </p>
            )}

            {state?.plan === tier.plan && state.kind === 'error' && (
              <p role="status" className="text-sm text-wrong">
                {plain(state.message, mode)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The name key per plan, for the gateway modal's description line. */
const TIER_NAME: Record<Plan, MessageKey> = {
  ai: 'mePlans.ai',
  pro: 'mePlans.pro',
};

/**
 * Drawn, never charged. Exported so the page can show the same two numbers
 * without a second copy of them, and so a reader can see there is exactly one
 * place a price is written in the browser.
 */
export { PLAN_PRICE_INR };
