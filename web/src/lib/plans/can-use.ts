/**
 * `can_use` in TypeScript (issue 21-plans-entitlements).
 *
 * The SQL function `public.can_use(user_id, feature)` in
 * `supabase/migrations/0021_entitlements.sql` is the authority: it runs inside
 * Postgres, under RLS, and no request can skip it. This file is the same truth
 * table in TS, for the UI, so a page can grey out a locked button without a
 * round trip. `src/lib/plans/__tests__/can-use.test.ts` and
 * `test/entitlements.test.ts` check the same cases, so the two cannot drift.
 *
 * Pure: no env, no fetch, no clock of its own (pass `now`).
 */
import { isFeature, isPlan, type Entitlement, type Feature, type Plan } from './types';

/** V18 prices, in rupees a month. */
export const PLAN_PRICE_INR: Record<Plan, number> = { ai: 100, pro: 500 };

/**
 * X6 (locked): Pro has the SAME 30-new-AI-explanations-a-day cap as the AI
 * plan. Saved explanations are unlimited. Counting the day's usage is its own
 * slice; this file only says what the cap is.
 */
export const AI_DAILY_CAP: Record<Plan, number> = { ai: 30, pro: 30 };

/** Which plans unlock which feature. The one place that answers it. */
export const FEATURE_PLANS: Record<Feature, readonly Plan[]> = {
  ai: ['ai', 'pro'],
  notes: ['pro'],
  analysis: ['pro'],
};

/** True while `validUntil` is still in the future. Unparsable = expired. */
function isLive(entitlement: Entitlement, now: Date): boolean {
  const until = Date.parse(entitlement.validUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/** The plans this student can use right now. */
export function activePlans(entitlements: readonly Entitlement[], now: Date = new Date()): Plan[] {
  return entitlements.filter((e) => isPlan(e.plan) && isLive(e, now)).map((e) => e.plan);
}

/**
 * The gate. Mirrors the SQL: `ai` needs the AI plan or Pro, `notes` and
 * `analysis` need Pro, an expired row unlocks nothing, and an unknown feature
 * is false rather than an error, so a typo fails closed.
 */
export function canUse(
  entitlements: readonly Entitlement[],
  feature: string,
  now: Date = new Date(),
): boolean {
  if (!isFeature(feature)) return false;
  const allowed = FEATURE_PLANS[feature];
  return activePlans(entitlements, now).some((plan) => allowed.includes(plan));
}
