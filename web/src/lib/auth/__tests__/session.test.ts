/**
 * Issue 03-sign-in: the session cookie.
 * Security constraint: the cookie is httpOnly and nothing in it is ever logged.
 */
import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
  type AuthSession,
} from '../session';

const session: AuthSession = {
  accessToken: 'header.payload.signature',
  refreshToken: 'refresh-abc',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'teacher',
};

describe('session cookie', () => {
  it('round-trips a session', () => {
    expect(decodeSession(encodeSession(session))).toEqual(session);
  });

  it('returns null for junk instead of throwing', () => {
    expect(decodeSession(undefined)).toBeNull();
    expect(decodeSession('')).toBeNull();
    expect(decodeSession('not base64 $$$')).toBeNull();
    expect(decodeSession(Buffer.from('{"nope":1}').toString('base64url'))).toBeNull();
  });

  it('rejects an unknown role', () => {
    const bad = Buffer.from(JSON.stringify({ ...session, role: 'superuser' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeSession(bad)).toBeNull();
  });

  it('is httpOnly, lax and site-wide', () => {
    const o = sessionCookieOptions();
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe('lax');
    expect(o.path).toBe('/');
  });

  it('uses one cookie name', () => {
    expect(SESSION_COOKIE).toBe('pp_session');
  });
});
