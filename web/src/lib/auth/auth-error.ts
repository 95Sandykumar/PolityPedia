/**
 * The HTTP status of a failed Supabase auth call, carried on the error
 * (issue 38-session-and-alerts-fixes).
 *
 * WHY THIS EXISTS. `refreshIfNeeded` used to map EVERY thrown error to
 * `failed`, and `failed` clears the session cookie. So a Supabase 5xx or a
 * network timeout signed the student out: mid-exam the middleware turned an
 * answer-save POST into a 307 to /sign-in, and the player's one 401 retry was
 * never reached. The student lost a three hour mock test to somebody else's
 * bad minute.
 *
 * Only Supabase ITSELF saying no means the refresh token is dead. It answers
 * 400 for a token that was already spent and 401 for one that was revoked.
 * Everything else, a 500, a 502, a timeout, a DNS failure, means "ask again
 * later", and the old access token may still have minutes left on it.
 *
 * The message is unchanged on purpose, so nothing that reads it breaks, and it
 * still carries NO response body: a Supabase auth body quotes the token.
 */

/** A Supabase auth call that came back with a status we did not want. */
export class AuthCallError extends Error {
  readonly status: number;
  /**
   * Supabase's `error_code` (example `otp_expired`), when the body had a safe
   * one (issue 64-signin-errors-and-resend). Never the message: that text can
   * quote the code or the token.
   */
  readonly code?: string;

  constructor(status: number, code?: string) {
    super('Supabase auth call failed with status ' + status);
    this.name = 'AuthCallError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/**
 * True ONLY when Supabase refused the refresh token itself.
 *
 * Reads a numeric `status` off anything, not just `AuthCallError`, so an error
 * from another layer with the same shape is understood too. Anything with no
 * status at all, which is what `fetch` throws for a timeout or a dead network,
 * is NOT a refusal: it fails open and the cookie survives.
 */
export function refusedRefreshToken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status } = error as { status?: unknown };
  return status === 400 || status === 401;
}
