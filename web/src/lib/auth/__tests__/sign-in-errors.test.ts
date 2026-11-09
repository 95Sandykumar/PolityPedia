/**
 * Issue 64-signin-errors-and-resend: map auth failures to a small set of
 * reasons, and reasons to message keys. Pure functions, no network.
 *
 * Issue 83-fix-wrong-code-says-expired: a code that did not work gets ONE
 * neutral reason. The auth service answers 403 for a wrong code and for an
 * expired one, and the `otp_expired` hint is not reliable, so we cannot tell
 * the two apart. The message must name both and never claim "expired" alone.
 */
import { describe, expect, it } from 'vitest';
import { dictionary } from '@/lib/i18n';
import { AuthCallError } from '../auth-error';
import {
  AuthRequestError,
  classifySendFailure,
  classifyVerifyFailure,
  queryErrorKey,
  reasonKey,
  reasonOf,
} from '../sign-in-errors';

/** Every refusal shape the auth service sends for a code that did not work. */
const REFUSALS = [
  new AuthCallError(403, 'otp_expired'),
  new AuthCallError(403),
  new AuthCallError(400),
  new AuthCallError(401),
  new AuthCallError(422),
];

describe('classifyVerifyFailure', () => {
  it('gives one neutral reason to every refusal, with or without otp_expired', () => {
    for (const error of REFUSALS) {
      expect(classifyVerifyFailure(error)).toBe('bad_code');
    }
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

describe('the failed-code message (83-fix-wrong-code-says-expired)', () => {
  it('is one and the same message for every refusal shape', () => {
    const keys = new Set(REFUSALS.map((error) => reasonKey(classifyVerifyFailure(error))));
    expect(keys).toEqual(new Set(['auth.err.badCode']));
  });

  it('names a wrong code AND an expired one, and points at Resend', () => {
    const en = dictionary.en['auth.err.badCode'];
    expect(en).toMatch(/wrong/i);
    expect(en).toMatch(/expire/i);
    expect(en).toContain(dictionary.en['auth.resend']);
  });

  it('points a Hindi reader at the same Resend button, in Hindi', () => {
    const hi = dictionary.hi['auth.err.badCode'];
    expect(hi).toContain(dictionary.hi['auth.resend']);
    expect(hi).not.toBe(dictionary.en['auth.err.badCode']);
  });

  it('drops the one-sided strings and the unused resendIn string', () => {
    for (const lang of ['en', 'hi'] as const) {
      expect(dictionary[lang]).not.toHaveProperty('auth.err.expired');
      expect(dictionary[lang]).not.toHaveProperty('auth.err.wrong');
      expect(dictionary[lang]).not.toHaveProperty('auth.resendIn');
    }
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
    expect(reasonOf(new AuthRequestError(401, 'bad_code'))).toBe('bad_code');
    expect(reasonOf(new Error('x'))).toBe('failed');
    expect(reasonOf(null)).toBe('failed');
  });

  it('gives each reason its own message key', () => {
    const keys = (['bad_code', 'rate_limited', 'failed'] as const).map((reason) =>
      reasonKey(reason),
    );
    expect(new Set(keys).size).toBe(3);
  });
});
