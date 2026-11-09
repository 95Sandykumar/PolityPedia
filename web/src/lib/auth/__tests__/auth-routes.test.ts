/**
 * Issue 64-signin-errors-and-resend: the send-code and verify-code routes.
 * Supabase is faked. No real network call, no real key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthCallError } from '../auth-error';
import type { ServerAuthClient } from '../types';

const state: { client: Partial<ServerAuthClient> } = { client: {} };

vi.mock('../supabase-auth-client', () => ({
  createSupabaseAuthClient: () => ({ isConfigured: () => true, ...state.client }),
}));

import { POST as sendCode } from '@/app/api/auth/send-code/route';
import { POST as verifyCode } from '@/app/api/auth/verify-code/route';

function req(body: unknown) {
  return new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  state.client = {};
});

describe('POST /api/auth/send-code', () => {
  it('returns the identical reply for a known and an unknown email', async () => {
    state.client = { sendEmailCode: vi.fn(async () => {}) };
    const known = await sendCode(req({ email: 'known@politypedia.test' }));
    const unknown = await sendCode(req({ email: 'nobody@politypedia.test' }));
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it('says rate_limited when the email provider limit is hit', async () => {
    state.client = {
      sendEmailCode: vi.fn(async () => {
        throw new AuthCallError(429, 'over_email_send_rate_limit');
      }),
    };
    const res = await sendCode(req({ email: 'a@b.test' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ reason: 'rate_limited' });
  });

  it('keeps other failures generic', async () => {
    state.client = {
      sendEmailCode: vi.fn(async () => {
        throw new AuthCallError(500);
      }),
    };
    const res = await sendCode(req({ email: 'a@b.test' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: 'failed' });
  });
});

describe('POST /api/auth/verify-code', () => {
  const body = { email: 'a@b.test', code: '424242' };

  it.each([
    [new AuthCallError(403, 'otp_expired'), 401, 'bad_code'],
    [new AuthCallError(403), 401, 'bad_code'],
    [new AuthCallError(429), 429, 'rate_limited'],
    [new AuthCallError(500), 502, 'failed'],
  ])('maps %o to %i and %s', async (error, status, reason) => {
    state.client = {
      verifyEmailCode: vi.fn(async () => {
        throw error;
      }),
    };
    const res = await verifyCode(req(body));
    expect(res.status).toBe(status);
    const text = JSON.stringify(await res.json());
    expect(text).toContain(reason);
    expect(text).not.toContain('424242');
  });
});
