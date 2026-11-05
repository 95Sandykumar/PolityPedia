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
import { readSupabaseEnv, type SupabaseEnv } from './env';
import { isRole, type AuthSession, type Role, type ServerAuthClient } from './types';

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  user?: { id?: unknown } | null;
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

  async function authPost(path: string, body: unknown): Promise<unknown> {
    const { url, anonKey } = required();
    const res = await doFetch(url + path, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + anonKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Supabase auth call failed with status ' + res.status);
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
    return {
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
      userId,
      role,
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
