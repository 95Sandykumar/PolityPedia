/**
 * The TS mirror of the SQL `can_use` (issue 21-plans-entitlements).
 * Same truth table as `test/entitlements.test.ts`, so the UI and Postgres
 * can never disagree about what a plan unlocks.
 */
import { describe, expect, it } from 'vitest';
import { AI_DAILY_CAP, canUse, activePlans, PLAN_PRICE_INR } from '../can-use';
import type { Entitlement } from '../types';
import { isFeature, isPlan } from '../types';

const NOW = new Date('2026-11-05T10:00:00Z');
const LATER = '2026-12-05T10:00:00Z';
const EARLIER = '2026-11-04T10:00:00Z';

const ai: Entitlement[] = [{ plan: 'ai', validUntil: LATER, source: 'admin' }];
const pro: Entitlement[] = [{ plan: 'pro', validUntil: LATER, source: 'razorpay' }];
const expiredPro: Entitlement[] = [{ plan: 'pro', validUntil: EARLIER, source: 'razorpay' }];

describe('canUse', () => {
  it('AI plan unlocks ai only', () => {
    expect(canUse(ai, 'ai', NOW)).toBe(true);
    expect(canUse(ai, 'notes', NOW)).toBe(false);
    expect(canUse(ai, 'analysis', NOW)).toBe(false);
  });

  it('Pro unlocks ai, notes and analysis', () => {
    expect(canUse(pro, 'ai', NOW)).toBe(true);
    expect(canUse(pro, 'notes', NOW)).toBe(true);
    expect(canUse(pro, 'analysis', NOW)).toBe(true);
  });

  it('an expired plan unlocks nothing', () => {
    expect(canUse(expiredPro, 'ai', NOW)).toBe(false);
    expect(canUse(expiredPro, 'notes', NOW)).toBe(false);
    expect(canUse(expiredPro, 'analysis', NOW)).toBe(false);
  });

  it('Free (no row) unlocks nothing', () => {
    expect(canUse([], 'ai', NOW)).toBe(false);
    expect(canUse([], 'notes', NOW)).toBe(false);
  });

  it('fails closed on an unknown feature', () => {
    expect(canUse(pro, 'teleport', NOW)).toBe(false);
    expect(canUse(pro, '', NOW)).toBe(false);
  });

  it('ignores a row whose valid_until cannot be parsed', () => {
    expect(canUse([{ plan: 'pro', validUntil: 'not a date', source: 'admin' }], 'ai', NOW)).toBe(
      false,
    );
  });

  it('treats the exact expiry instant as over, like `valid_until > now()`', () => {
    expect(canUse([{ plan: 'pro', validUntil: NOW.toISOString(), source: 'admin' }], 'ai', NOW)).toBe(
      false,
    );
  });

  it('takes the best of several rows', () => {
    const both: Entitlement[] = [
      { plan: 'ai', validUntil: LATER, source: 'admin' },
      { plan: 'pro', validUntil: EARLIER, source: 'razorpay' },
    ];
    expect(canUse(both, 'ai', NOW)).toBe(true);
    expect(canUse(both, 'notes', NOW)).toBe(false);
  });
});

describe('activePlans', () => {
  it('lists only the plans that are still valid', () => {
    const rows: Entitlement[] = [
      { plan: 'ai', validUntil: LATER, source: 'admin' },
      { plan: 'pro', validUntil: EARLIER, source: 'razorpay' },
    ];
    expect(activePlans(rows, NOW)).toEqual(['ai']);
  });

  it('is empty for a free student', () => {
    expect(activePlans([], NOW)).toEqual([]);
  });
});

describe('plan facts (V18, X6)', () => {
  it('prices the two plans at Rs 100 and Rs 500', () => {
    expect(PLAN_PRICE_INR).toEqual({ ai: 100, pro: 500 });
  });

  it('gives Pro the same 30-a-day AI cap as the AI plan (X6)', () => {
    expect(AI_DAILY_CAP).toEqual({ ai: 30, pro: 30 });
  });
});

describe('guards', () => {
  it('accepts only ai and pro as a plan', () => {
    expect(isPlan('ai')).toBe(true);
    expect(isPlan('pro')).toBe(true);
    expect(isPlan('platinum')).toBe(false);
    expect(isPlan(7)).toBe(false);
  });

  it('accepts only ai, notes and analysis as a feature', () => {
    expect(isFeature('ai')).toBe(true);
    expect(isFeature('notes')).toBe(true);
    expect(isFeature('analysis')).toBe(true);
    expect(isFeature('teleport')).toBe(false);
  });
});
