/**
 * The plans contract for PolityPedia (issue 21-plans-entitlements).
 *
 * V18: Free; AI plan Rs 100/month (AI only); Pro Rs 500/month (AI + notes +
 * score vs cut-off). Mock sets are sold separately and are NOT a plan.
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call and no real key anywhere in the test suite (web/CLAUDE.md).
 *
 * Two clients, because a key must never reach the browser:
 * - `PlansClient` runs on the server and talks to Supabase REST with the
 *   signed-in admin's own access token, so RLS is the real gate.
 * - `AdminPlansClient` runs in the page and talks to our own route handler.
 */

/** A paid plan. The row in `public.entitlements`. */
export type Plan = 'ai' | 'pro';

/** Something `can_use(user, feature)` can be asked about. */
export type Feature = 'ai' | 'notes' | 'analysis';

/** Why the row exists. `admin` = granted by hand (this issue). */
export type EntitlementSource = 'admin' | 'razorpay';

export const PLANS: readonly Plan[] = ['ai', 'pro'];
export const FEATURES: readonly Feature[] = ['ai', 'notes', 'analysis'];

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && (FEATURES as readonly string[]).includes(value);
}

/** One stored plan for one user. `validUntil` is an ISO timestamp. */
export interface Entitlement {
  plan: Plan;
  validUntil: string;
  source: EntitlementSource;
}

export interface GrantInput {
  userId: string;
  plan: Plan;
  /** ISO timestamp. The plan is live while this is in the future. */
  validUntil: string;
}

export interface EndInput {
  userId: string;
  plan: Plan;
}

/** Server side. Carries the admin's access token, so Postgres RLS decides. */
export interface PlansClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** Grant a plan, or move `valid_until` if the student already has it. */
  grant(input: GrantInput): Promise<void>;
  /** End a plan now by deleting the row. */
  end(input: EndInput): Promise<void>;
  /** Every stored plan for one student. Empty list on any failure. */
  list(userId: string): Promise<Entitlement[]>;
  /** Ask the SQL gate `can_use(user_id, feature)`. False on any failure. */
  canUse(userId: string, feature: Feature): Promise<boolean>;
}

/** Browser side. Calls our own routes; never sees a Supabase key. */
export interface AdminPlansClient {
  grant(input: GrantInput): Promise<void>;
  end(input: EndInput): Promise<void>;
}

// --------------------------------------------------------------------------
// Paid subscriptions (issue 28-plan-subscriptions)
// --------------------------------------------------------------------------

/**
 * V18's two prices, for the Me > Plans page to DRAW.
 *
 * Drawn and never charged. The bill comes from `plan_price_inr()` in Postgres
 * (F-G2), which is why `start_plan_subscription()` takes a plan name and no
 * amount. A student who edits this object changes a label, not a bill, and
 * `test/subscriptions.test.ts` holds the same two numbers against the
 * database.
 */
export const PLAN_PRICE_INR: Record<Plan, number> = { ai: 100, pro: 500 };

/** `subscriptions.status` in 0028. */
export type SubscriptionStatus = 'created' | 'active' | 'cancelled' | 'halted';

/** What `start_plan_subscription()` hands back. */
export interface StartedSubscription {
  /** OUR row id, a uuid. Not Razorpay's. */
  subscriptionId: string;
  /** Rupees quoted by Postgres. Never read from a request. */
  amountInr: number;
  status: SubscriptionStatus;
}

/**
 * Server side. Carries the student's own access token, so `auth.uid()` inside
 * `start_plan_subscription()` is them and nobody else.
 */
export interface SubscriptionsClient {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  /** `start_plan_subscription()`. Throws `PurchaseError` on a refusal. */
  start(plan: Plan): Promise<StartedSubscription>;
  /** `attach_subscription_id()`. Single-shot inside Postgres (A1). */
  attachSubscriptionId(subscriptionId: string, razorpaySubscriptionId: string): Promise<void>;
  /**
   * The student's own subscription rows, so Me > Plans can say "Stopped".
   * Read through `subscriptions_select_own`, so it can only ever be theirs.
   * Empty list on any failure: a page that cannot read a status should draw
   * the plain card, not an error.
   */
  list(): Promise<SubscriptionRow[]>;
}

/** What the page needs to open Razorpay's subscription checkout. No secret. */
export interface SubscribeStart {
  /** Our own row id. */
  subscriptionId: string;
  /** Razorpay's own id, which its checkout modal needs. */
  razorpaySubscriptionId: string;
  /** Rupees, for the receipt line on screen. Postgres quoted it. */
  amountInr: number;
  plan: Plan;
  /** The PUBLIC key id. */
  keyId: string;
}

/** Browser side. Calls our own route; never sees a key. */
export interface BrowserSubscribeClient {
  start(plan: Plan): Promise<SubscribeStart>;
}

/** One stored subscription, for Me > Plans to show "Pro, active". */
export interface SubscriptionRow {
  plan: Plan;
  status: SubscriptionStatus;
}
