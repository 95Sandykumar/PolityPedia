/**
 * Read our one session cookie off a raw request header
 * (issue 05-teacher-invite-approval).
 *
 * The same three lines appeared in the plans route. Both teacher routes need
 * it, so it lives here once. Never throws, and never logs: the cookie holds
 * tokens.
 */
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';

export function readSessionCookie(request: Request): AuthSession | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    return decodeSession(part.slice(at + 1).trim());
  }
  return null;
}
