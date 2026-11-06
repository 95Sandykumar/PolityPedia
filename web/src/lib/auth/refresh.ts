/**
 * Renew the access token before it dies (issue 33-session-refresh).
 *
 * The cookie lasts 7 days; the access token inside it lasts about an hour. A
 * mock test may run 360 minutes (`mock_tests.duration_min`), so without this
 * every answer save in a three hour exam failed with 401 after minute 60 while
 * the middleware still read the student as signed in, and `score_attempt`
 * failed too, so `submitted_at` was never set.
 *
 * Pure decision logic over the `ServerAuthClient` interface, so the tests
 * drive it with the fake: no network call and no key.
 *
 * KNOWN LIMIT, on purpose for v1: Supabase rotates the refresh token, so two
 * requests that renew at the same instant race and one of them loses its
 * token. The browser sends requests over one cookie jar and the renew happens
 * on a page load, so this is rare; the loser is simply asked to sign in again.
 * Locking the renew needs server-side session storage, which is a later issue.
 *
 * Security: nothing here is logged. Every value in sight is a secret.
 */
import { refusedRefreshToken } from './auth-error';
import { needsRefresh, type AuthSession } from './session';
import type { ServerAuthClient } from './types';

export type RefreshOutcome =
  /** Nothing to do: the token is good, or Supabase is not configured. */
  | { kind: 'fresh'; session: AuthSession }
  /** New tokens. The caller MUST write them back into the cookie. */
  | { kind: 'refreshed'; session: AuthSession }
  /**
   * Revoked or spent: SUPABASE said no, with a 400 or a 401. The caller MUST
   * clear the cookie, because nothing will ever renew this session again.
   */
  | { kind: 'failed' }
  /**
   * We could not ask (issue 38-session-and-alerts-fixes): a 5xx, a timeout or
   * a dead network. The caller MUST KEEP THE COOKIE and carry on with the
   * session handed back here. Nothing says this token is bad, the old access
   * token may still have minutes on it, and the next request tries again.
   *
   * This used to be `failed` too, which cleared the cookie: one bad Supabase
   * minute signed a student out in the middle of a three hour mock test and
   * turned their answer-save POST into a redirect to /sign-in.
   */
  | { kind: 'unavailable'; session: AuthSession };

export interface RefreshInput {
  session: AuthSession;
  client: ServerAuthClient;
  nowMs?: number;
}

export async function refreshIfNeeded({
  session,
  client,
  nowMs = Date.now(),
}: RefreshInput): Promise<RefreshOutcome> {
  if (!needsRefresh(session, nowMs)) return { kind: 'fresh', session };
  // No keys on this box: a page says "not configured" rather than signing
  // everybody out, so the session is left exactly as it was.
  if (!client.isConfigured()) return { kind: 'fresh', session };
  // Nothing to spend. A session we cannot renew is not a session.
  if (!session.refreshToken) return { kind: 'failed' };

  try {
    // What this user ALREADY was goes with the renew
    // (issue 39-profile-read-keeps-role). The role lives in the `profiles`
    // table, so the client reads it after every token response; when that read
    // does not answer it keeps these values instead of inventing `student`.
    // Without this, one 500 from the profile read wrote `role: 'student'` into
    // the cookie and an admin or an approved teacher was a student for the 7
    // days the cookie lives.
    const renewed = await client.refreshSession(session.refreshToken, {
      role: session.role,
      ...(session.teacherStatus === undefined ? {} : { teacherStatus: session.teacherStatus }),
    });
    return { kind: 'refreshed', session: renewed };
  } catch (error) {
    // THE ONLY ERROR THAT ENDS A SESSION is Supabase refusing the token
    // itself: 400 for one already spent, 401 for one revoked. A 5xx, a
    // timeout and a thrown `fetch` all fail OPEN, because an outage is not a
    // sign-out. Nothing is logged: every value in sight is a secret.
    if (refusedRefreshToken(error)) return { kind: 'failed' };
    return { kind: 'unavailable', session };
  }
}

export interface RefreshReply {
  /** 200 carry on, 401 sign in again, 503 Supabase could not be reached. */
  status: number;
  /** The session to write into the cookie, or null to leave it alone. */
  session: AuthSession | null;
  /** True to delete the cookie. */
  clearCookie: boolean;
}

/**
 * POST /api/auth/refresh, for the exam player's one retry after a 401.
 *
 * 200 means "carry on": either the token was still good or it was renewed.
 * 401 means the student has to sign in again, and the cookie is cleared so the
 * middleware agrees with the answer.
 * 503 means Supabase could not be reached, so NOTHING was decided
 * (issue 38-session-and-alerts-fixes). The cookie stays exactly as it was and
 * the caller may try again. It is not a 200, because nothing was renewed, and
 * it is not a 401, because the student is not signed out.
 */
export async function handleRefresh({
  session,
  client,
  nowMs,
}: {
  session: AuthSession | null;
  client: ServerAuthClient;
  nowMs?: number;
}): Promise<RefreshReply> {
  if (!session) return { status: 401, session: null, clearCookie: true };

  const outcome = await refreshIfNeeded({ session, client, nowMs });
  if (outcome.kind === 'refreshed') {
    return { status: 200, session: outcome.session, clearCookie: false };
  }
  if (outcome.kind === 'fresh') return { status: 200, session: null, clearCookie: false };
  if (outcome.kind === 'unavailable') {
    return { status: 503, session: null, clearCookie: false };
  }
  return { status: 401, session: null, clearCookie: true };
}
