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
