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
  /** Where to send the browser to start Google sign-in. */
  googleAuthorizeUrl(redirectTo: string, challenge: string): string;
}

/** Browser side. Calls our own routes; never sees a Supabase key. */
export interface BrowserAuthClient {
  sendEmailCode(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
}
