/**
 * Razorpay env presence and KEY MODE (issue 44-h5-golive-readiness).
 *
 * The mode is the single most dangerous fact on go-live day: test keys take no
 * money, live keys take real money, and a MIX takes money that nothing can
 * reconcile. Every case here is a case Boss could really be in.
 *
 * No real key is in this file. `rzp_test_x` and `rzp_live_x` are prefixes plus
 * one letter, which is what the detector reads and all it reads.
 */
import { describe, expect, it } from 'vitest';
import {
  RAZORPAY_OPTIONAL_ENV,
  RAZORPAY_REQUIRED_ENV,
  checkCheckoutSrc,
  checkKeyMode,
  checkRazorpayEnv,
  detectKeyMode,
} from '../keys';

describe('detectKeyMode', () => {
  it('reads a test pair as test', () => {
    const found = detectKeyMode({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'rzp_test_sec' });
    expect(found.mode).toBe('test');
  });

  it('reads a live pair as live', () => {
    const found = detectKeyMode({ RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 'rzp_live_sec' });
    expect(found.mode).toBe('live');
  });

  it('reads a test id with a live secret as mixed', () => {
    const found = detectKeyMode({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'rzp_live_sec' });
    expect(found.mode).toBe('mixed');
  });

  it('reads a live id with a test secret as mixed', () => {
    const found = detectKeyMode({ RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 'rzp_test_sec' });
    expect(found.mode).toBe('mixed');
  });

  it('reads nothing set as missing', () => {
    expect(detectKeyMode({}).mode).toBe('missing');
  });

  it('takes the mode from the key id when the secret carries no prefix', () => {
    // Razorpay's real secrets have no rzp_ prefix, so this is the normal case.
    const found = detectKeyMode({ RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 'plainsecret' });
    expect(found.mode).toBe('live');
  });

  it('is unknown when the id carries no prefix at all', () => {
    expect(detectKeyMode({ RAZORPAY_KEY_ID: 'nope', RAZORPAY_KEY_SECRET: 'nope' }).mode).toBe('unknown');
  });
});

describe('checkRazorpayEnv', () => {
  it('passes when every required name is set and never prints a value', () => {
    const check = checkRazorpayEnv({
      RAZORPAY_KEY_ID: 'rzp_test_abc',
      RAZORPAY_KEY_SECRET: 'supersecretvalue',
      RAZORPAY_WEBHOOK_SECRET: 'anothersecretvalue',
    });
    expect(check.status).toBe('PASS');
    expect(check.detail).not.toContain('supersecretvalue');
    expect(check.detail).not.toContain('anothersecretvalue');
    expect(check.detail).not.toContain('rzp_test_abc');
  });

  it('fails and names what is missing', () => {
    const check = checkRazorpayEnv({ RAZORPAY_KEY_ID: 'rzp_test_abc' });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('RAZORPAY_KEY_SECRET');
    expect(check.detail).toContain('RAZORPAY_WEBHOOK_SECRET');
    expect(check.fix).toBeTruthy();
  });

  it('warns about a missing plan id, because a plan is only needed for subscriptions', () => {
    const check = checkRazorpayEnv({
      RAZORPAY_KEY_ID: 'rzp_test_abc',
      RAZORPAY_KEY_SECRET: 'a',
      RAZORPAY_WEBHOOK_SECRET: 'b',
    });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('RAZORPAY_PLAN_PRO_ID');
  });

  it('knows the required and the optional names', () => {
    expect([...RAZORPAY_REQUIRED_ENV]).toEqual([
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ]);
    expect([...RAZORPAY_OPTIONAL_ENV]).toEqual(['RAZORPAY_PLAN_PRO_ID', 'RAZORPAY_PLAN_AI_ID']);
  });
});

describe('checkCheckoutSrc', () => {
  it('passes, because the checkout URL is a code constant and not env', () => {
    const check = checkCheckoutSrc();
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('checkout.razorpay.com');
  });
});

describe('checkKeyMode', () => {
  it('warns on test keys when test is expected', () => {
    const check = checkKeyMode({
      env: { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 'rzp_test_b' },
      expect: 'test',
      othersClear: true,
    });
    expect(check.status).toBe('WARN');
    expect(check.detail).toContain('no real money');
  });

  it('fails on test keys when live is expected', () => {
    const check = checkKeyMode({
      env: { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 'rzp_test_b' },
      expect: 'live',
      othersClear: true,
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes on live keys only when every other money check is clear', () => {
    const live = { RAZORPAY_KEY_ID: 'rzp_live_a', RAZORPAY_KEY_SECRET: 'rzp_live_b' };
    expect(checkKeyMode({ env: live, expect: 'live', othersClear: true }).status).toBe('PASS');
    expect(checkKeyMode({ env: live, expect: 'live', othersClear: false }).status).toBe('FAIL');
  });

  it('always fails a mixed pair, whatever is expected', () => {
    const mixed = { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 'rzp_live_b' };
    expect(checkKeyMode({ env: mixed, expect: 'test', othersClear: true }).status).toBe('FAIL');
    expect(checkKeyMode({ env: mixed, expect: 'live', othersClear: true }).status).toBe('FAIL');
  });

  it('fails a missing pair', () => {
    expect(checkKeyMode({ env: {}, expect: 'test', othersClear: true }).status).toBe('FAIL');
  });
});
