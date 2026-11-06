/**
 * The one fake `ServerAuthClient` in the suite (issue 33-session-refresh).
 *
 * It lives beside the real client, not inside a test file, because the refresh
 * test, the middleware test and the sign-out test all need the SAME fake, and
 * three copies of a fake drift apart.
 *
 * It touches no network and holds no key (web/CLAUDE.md), and it throws the
 * SAME `AuthCallError`, with the same status on it, exactly where
 * `createSupabaseAuthClient()` throws one, so a test that passes here cannot
 * pass for the wrong reason. The status is the whole point: 400 and 401 mean
 * the refresh token is dead, anything else means the network was
 * (issue 38-session-and-alerts-fixes).
 */
import { AuthCallError } from './auth-error';
import type { AuthSession, ServerAuthClient } from './types';

/**
 * How `refreshSession()` fails when it is not an HTTP status
 * (issue 38-session-and-alerts-fixes): the two ways `fetch` itself gives up.
 * Neither carries a status, and neither means the refresh token is dead.
 */
export type RefreshFailure = 'timeout' | 'network';

export interface FakeAuthClientOptions {
  /** False to act like a box with no Supabase env vars. */
  configured?: boolean;
  /** Throw from `refreshSession()`: the revoked-token path (status 400). */
  failRefresh?: boolean;
  /**
   * Throw from `refreshSession()` with THIS status
   * (issue 38-session-and-alerts-fixes). 400 and 401 are a dead token; 500 and
   * 503 are an outage that must NOT sign the student out.
   */
  refreshStatus?: number;
  /** Throw from `refreshSession()` the way `fetch` does, with no status. */
  failRefreshWith?: RefreshFailure;
  /** Throw from `signOut()`: Supabase refusing the revoke. */
  failSignOut?: boolean;
  /** `expiresAt` the renewed session carries. */
  nextExpiresAt?: number;
  /** The user the renewed session belongs to. */
  userId?: string;
}

export interface FakeAuthClient {
  client: ServerAuthClient;
  /** Every refresh token handed to `refreshSession()`, in order. */
  readonly refreshCalls: string[];
  /** Every access token handed to `signOut()`, in order. */
  readonly signOutCalls: string[];
}

const DEFAULT_USER = '11111111-1111-4111-8111-111111111111';

export function createFakeAuthClient(options: FakeAuthClientOptions = {}): FakeAuthClient {
  const configured = options.configured ?? true;
  const refreshCalls: string[] = [];
  const signOutCalls: string[] = [];

  const client: ServerAuthClient = {
    isConfigured() {
      return configured;
    },
    async sendEmailCode() {
      throw new Error('not used by this fake');
    },
    async verifyEmailCode() {
      throw new Error('not used by this fake');
    },
    async exchangeCodeForSession() {
      throw new Error('not used by this fake');
    },
    googleAuthorizeUrl() {
      return 'https://proj.supabase.test/auth/v1/authorize';
    },
    async refreshSession(refreshToken: string): Promise<AuthSession> {
      refreshCalls.push(refreshToken);
      // No status at all, exactly like a real `fetch` that never answered.
      if (options.failRefreshWith === 'timeout') {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      if (options.failRefreshWith === 'network') throw new TypeError('fetch failed');
      if (options.refreshStatus !== undefined) throw new AuthCallError(options.refreshStatus);
      if (options.failRefresh) throw new AuthCallError(400);
      return {
        accessToken: 'new.access.token',
        refreshToken: 'new-refresh',
        userId: options.userId ?? DEFAULT_USER,
        role: 'student',
        ...(options.nextExpiresAt === undefined ? {} : { expiresAt: options.nextExpiresAt }),
      };
    },
    async signOut(accessToken: string): Promise<void> {
      signOutCalls.push(accessToken);
      if (options.failSignOut) throw new AuthCallError(500);
    },
  };

  return { client, refreshCalls, signOutCalls };
}
