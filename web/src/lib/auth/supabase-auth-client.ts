/**
 * Server-side AuthClient over the Supabase Auth REST API (issue 03-sign-in).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build that has no environment variables.
 *
 * Security (issue 03 design constraint): the emailed code and every token are
 * secrets. No console call lives in this file, and the errors it throws carry
 * only a fixed message plus the HTTP status, never a response body.
 */
import { isTeacherStatus, type TeacherStatus } from '@/lib/teachers/types';
import { AuthCallError } from './auth-error';
import { readSupabaseEnv, type SupabaseEnv } from './env';
import { isRole, type AuthSession, type Role, type ServerAuthClient } from './types';

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  /** Seconds from now (issue 33-session-refresh). */
  expires_in?: unknown;
  /** Epoch seconds. Preferred, because it does not trust our clock twice. */
  expires_at?: unknown;
  user?: { id?: unknown } | null;
}

/**
 * When the access token dies, in epoch seconds, or undefined when Supabase
 * did not say (issue 33-session-refresh). Undefined is read as "stale" by
 * `needsRefresh`, so the worst case is one extra renewal, never a dead token
 * treated as live.
 */
function expiryOf(body: TokenResponse, nowMs: number): number | undefined {
  if (typeof body.expires_at === 'number' && Number.isFinite(body.expires_at)) {
    return body.expires_at;
  }
  if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)) {
    return Math.floor(nowMs / 1000) + body.expires_in;
  }
  return undefined;
}

export interface SupabaseAuthClientOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseAuthClient(
  options: SupabaseAuthClientOptions = {},
): ServerAuthClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  /**
   * `accessToken` replaces the anon key in the Authorization header, which is
   * what `/auth/v1/logout` needs: it revokes THIS session, so it has to be
   * told which one by the token itself.
   */
  async function authPost(path: string, body: unknown, accessToken?: string): Promise<unknown> {
    const { url, anonKey } = required();
    const res = await doFetch(url + path, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + (accessToken ?? anonKey),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    // AuthCallError and not a plain Error: the STATUS has to survive the
    // throw, because 400 and 401 mean "this token is dead, sign out" while a
    // 500 or a timeout means "ask again later, keep the cookie"
    // (issue 38-session-and-alerts-fixes). Same message as before.
    if (!res.ok) throw new AuthCallError(res.status);
    return res.status === 204 ? null : ((await res.json()) as unknown);
  }

  /**
   * Read the signed-in user's own profile role with their access token, so RLS
   * (`profiles_select_own`) decides what is visible. Falls back to `student`,
   * the same default as the profiles table, when the row is not readable yet.
   */
  async function readRole(accessToken: string): Promise<Role> {
    const { url, anonKey } = required();
    const res = await doFetch(url + '/rest/v1/profiles?select=role', {
      method: 'GET',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + accessToken,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return 'student';
    const rows = (await res.json()) as unknown;
    const first = Array.isArray(rows) ? (rows[0] as { role?: unknown } | undefined) : undefined;
    return isRole(first?.role) ? first.role : 'student';
  }

  /**
   * A teacher's own `teachers.status` (issue 05-teacher-invite-approval), read
   * with their access token so `teachers_select_own` decides. Only asked for
   * when the role is `teacher`, so a student still signs in with one call.
   * Anything unreadable comes back as `pending`: the guard fails closed.
   */
  async function readTeacherStatus(accessToken: string): Promise<TeacherStatus> {
    const { url, anonKey } = required();
    const res = await doFetch(url + '/rest/v1/teachers?select=status', {
      method: 'GET',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + accessToken,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return 'pending';
    const rows = (await res.json()) as unknown;
    const first = Array.isArray(rows) ? (rows[0] as { status?: unknown } | undefined) : undefined;
    return isTeacherStatus(first?.status) ? first.status : 'pending';
  }

  async function toSession(payload: unknown): Promise<AuthSession> {
    const body = (payload ?? {}) as TokenResponse;
    const accessToken = body.access_token;
    const userId = body.user?.id;
    if (typeof accessToken !== 'string' || typeof userId !== 'string') {
      throw new Error('Supabase auth returned no session');
    }
    const role = await readRole(accessToken);
    const expiresAt = expiryOf(body, Date.now());
    return {
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
      userId,
      role,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(role === 'teacher' ? { teacherStatus: await readTeacherStatus(accessToken) } : {}),
    };
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async sendEmailCode(email) {
      await authPost('/auth/v1/otp', { email, create_user: true });
    },

    async verifyEmailCode(email, code) {
      return toSession(await authPost('/auth/v1/verify', { email, token: code, type: 'email' }));
    },

    async exchangeCodeForSession(code, verifier) {
      return toSession(
        await authPost('/auth/v1/token?grant_type=pkce', {
          auth_code: code,
          code_verifier: verifier,
        }),
      );
    },

    /**
     * Issue 33-session-refresh. Supabase ROTATES the refresh token, so the one
     * passed in is dead after this call: the caller must store what comes back
     * or the session is lost.
     */
    async refreshSession(refreshToken) {
      return toSession(
        await authPost('/auth/v1/token?grant_type=refresh_token', {
          refresh_token: refreshToken,
        }),
      );
    },

    /** Issue 33-session-refresh. Revokes this one session, not every device. */
    async signOut(accessToken) {
      await authPost('/auth/v1/logout?scope=local', {}, accessToken);
    },

    googleAuthorizeUrl(redirectTo, challenge) {
      const { url } = required();
      const authorize = new URL(url + '/auth/v1/authorize');
      authorize.searchParams.set('provider', 'google');
      authorize.searchParams.set('redirect_to', redirectTo);
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 's256');
      return authorize.toString();
    },
  };
}
