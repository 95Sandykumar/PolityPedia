/**
 * Issue 64-signin-errors-and-resend: map auth failures to a small set of
 * reasons, and reasons to message keys. Pure functions, no network.
 */
import { describe, expect, it } from 'vitest';
import { AuthCallError } from '../auth-error';
import {
  AuthRequestError,
  classifySendFailure,
  classifyVerifyFailure,
  queryErrorKey,
  reasonKey,
  reasonOf,
} from '../sign-in-errors';

describe('classifyVerifyFailure', () => {
  it('reads otp_expired as an expired code', () => {
    expect(classifyVerifyFailure(new AuthCallError(403, 'otp_expired'))).toBe('expired');
  });

  it('reads a plain refusal as a wrong code', () => {
    expect(classifyVerifyFailure(new AuthCallError(403))).toBe('wrong');
    expect(classifyVerifyFailure(new AuthCallError(400))).toBe('wrong');
    expect(classifyVerifyFailure(new AuthCallError(422))).toBe('wrong');
  });

  it('reads a 429 or a rate limit code as rate limited', () => {
    expect(classifyVerifyFailure(new AuthCallError(429))).toBe('rate_limited');
    expect(classifyVerifyFailure(new AuthCallError(403, 'over_email_send_rate_limit'))).toBe(
      'rate_limited',
    );
  });

  it('reads a 5xx or a thrown fetch as a plain failure', () => {
    expect(classifyVerifyFailure(new AuthCallError(500))).toBe('failed');
    expect(classifyVerifyFailure(new TypeError('fetch failed'))).toBe('failed');
  });
});

describe('classifySendFailure', () => {
  it('flags the email provider rate limit', () => {
    expect(classifySendFailure(new AuthCallError(429))).toBe('rate_limited');
    expect(classifySendFailure(new AuthCallError(429, 'over_email_send_rate_limit'))).toBe(
      'rate_limited',
    );
    expect(classifySendFailure(new AuthCallError(400, 'over_email_send_rate_limit'))).toBe(
      'rate_limited',
    );
  });

  it('keeps every other failure generic', () => {
    expect(classifySendFailure(new AuthCallError(500))).toBe('failed');
    expect(classifySendFailure(new Error('x'))).toBe('failed');
  });
});

describe('queryErrorKey', () => {
  it.each([
    ['denied', 'auth.q.denied'],
    ['no_code', 'auth.q.noCode'],
    ['expired', 'auth.q.expired'],
    ['failed', 'auth.q.failed'],
    ['not_configured', 'auth.q.notConfigured'],
  ])('maps ?error=%s to %s', (raw, key) => {
    expect(queryErrorKey(raw)).toBe(key);
  });

  it('ignores anything else, so a crafted URL cannot print its own text', () => {
    expect(queryErrorKey('<script>')).toBeNull();
    expect(queryErrorKey(undefined)).toBeNull();
    expect(queryErrorKey(['denied'])).toBeNull();
    expect(queryErrorKey('')).toBeNull();
  });
});

describe('reasonOf and reasonKey', () => {
  it('reads the reason off an AuthRequestError only', () => {
    expect(reasonOf(new AuthRequestError(401, 'expired'))).toBe('expired');
    expect(reasonOf(new Error('x'))).toBe('failed');
    expect(reasonOf(null)).toBe('failed');
  });

  it('gives each reason its own message key', () => {
    const keys = ['wrong', 'expired', 'rate_limited', 'failed'].map((r) =>
      reasonKey(r as 'wrong' | 'expired' | 'rate_limited' | 'failed'),
    );
    expect(new Set(keys).size).toBe(4);
  });
});
