/**
 * The session cookie (issue 03-sign-in).
 *
 * One httpOnly cookie holds the Supabase tokens plus the role. The role is a
 * routing hint only: it decides which page the middleware shows, nothing more.
 * The real gate is Postgres RLS, which checks the access-token JWT on every
 * query, so a forged cookie can reach a page shell but reads no data.
 *
 * Security: never log a value from this module. It holds tokens.
 */
import { isTeacherStatus } from '@/lib/teachers/types';
import { isRole, type AuthSession, type Role, type TeacherStatus } from './types';

export type { AuthSession, Role, TeacherStatus };

export const SESSION_COOKIE = 'pp_session';

/** 7 days, matching a Supabase refresh-token window. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
}

export function sessionCookieOptions(
  env: Record<string, string | undefined> = process.env,
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Plain http only on a local dev box, so the cookie still works there.
    secure: env.NODE_ENV === 'production',
    maxAge: MAX_AGE_SECONDS,
  };
}

export function encodeSession(session: AuthSession): string {
  return toBase64Url(JSON.stringify(session));
}

/** Returns null for anything that is not a session we wrote. Never throws. */
export function decodeSession(value: string | undefined | null): AuthSession | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(value));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { accessToken, refreshToken, userId, role, teacherStatus } = parsed as Record<
      string,
      unknown
    >;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    if (typeof refreshToken !== 'string') return null;
    if (typeof userId !== 'string' || !userId) return null;
    if (!isRole(role)) return null;
    // Optional (issue 05): a cookie written before teachers existed has no
    // status, and a value we do not know is dropped, so the guard reads it as
    // pending either way.
    if (teacherStatus === undefined || !isTeacherStatus(teacherStatus)) {
      return { accessToken, refreshToken, userId, role };
    }
    return { accessToken, refreshToken, userId, role, teacherStatus };
  } catch {
    return null;
  }
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9\-_]+$/.test(value)) throw new Error('not base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
