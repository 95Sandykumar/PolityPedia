/**
 * The auth contract for PolityPedia (issue 03-sign-in).
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call and no real key anywhere in the test suite.
 *
 * Two clients, because a key must never reach the browser:
 * - `ServerAuthClient` runs on the server and talks to Supabase Auth.
 * - `BrowserAuthClient` runs in the page and talks to our own route handlers,
 *   which hold the key and set the httpOnly session cookie.
 */
import type { TeacherStatus } from '@/lib/teachers/types';

export type Role = 'student' | 'teacher' | 'admin';

export type { TeacherStatus };

export const ROLES: readonly Role[] = ['student', 'teacher', 'admin'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** What we keep for a signed-in user. Stored in one httpOnly cookie. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  role: Role;
  /**
   * `teachers.status` for a teacher, absent for everybody else
   * (issue 05-teacher-invite-approval). A routing hint, like `role`: the
   * middleware keeps a pending teacher on the pending page. Missing is read
   * as pending, so an old cookie fails closed.
   */
  teacherStatus?: TeacherStatus;
  /**
   * When `accessToken` stops working, in epoch SECONDS
   * (issue 33-session-refresh).
   *
   * A Supabase access token lasts about an hour, while this cookie lasts a
   * week, so without this we could not tell a live token from a dead one and
   * every call made inside a long mock test failed with 401 after minute 60.
   *
   * Optional: a cookie written before issue 33 has no expiry, and that is read
   * as "assume it is stale", so the next request renews it.
   */
  expiresAt?: number;
}

/**
 * What the caller ALREADY knew about the user, handed to `refreshSession` so a
 * failed profile read cannot downgrade them (issue 39-profile-read-keeps-role).
 *
 * The role lives in the `profiles` table, not in the token, so every token
 * response is followed by a read. When that read does not answer, the renewed
 * session keeps these values instead of inventing `student`. A first sign-in
 * has no previous role, so it keeps the fail-closed default.
 */
export interface PreviousRole {
  role: Role;
  teacherStatus?: TeacherStatus;
}

/** Server side. Holds the Supabase key, so it never ships to the browser. */
export interface ServerAuthClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** Ask Supabase to email a 6-digit code. */
  sendEmailCode(email: string): Promise<void>;
  /** Swap the emailed code for a session. */
  verifyEmailCode(email: string, code: string): Promise<AuthSession>;
  /** Swap a Google `?code=` for a session (PKCE). */
  exchangeCodeForSession(code: string, verifier: string): Promise<AuthSession>;
  /**
   * Swap a refresh token for a fresh access token (issue 33-session-refresh).
   * Throws when the refresh token was revoked or already spent.
   *
   * `previous` is what the old cookie said (issue 39-profile-read-keeps-role).
   * Pass it on every renew: it is the floor the role cannot fall below when
   * the profile read fails. Omit it only where there is no previous session.
   */
  refreshSession(refreshToken: string, previous?: PreviousRole): Promise<AuthSession>;
  /** Revoke this session at Supabase (issue 33-session-refresh). */
  signOut(accessToken: string): Promise<void>;
  /** Where to send the browser to start Google sign-in. */
  googleAuthorizeUrl(redirectTo: string, challenge: string): string;
}

/** Browser side. Calls our own routes; never sees a Supabase key. */
export interface BrowserAuthClient {
  sendEmailCode(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
}
