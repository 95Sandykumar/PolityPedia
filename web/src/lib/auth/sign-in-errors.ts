/**
 * Why a sign-in step failed, as a small set of reasons (issue 64-signin-errors-and-resend).
 *
 * Pure and browser safe: no env, no network. The routes use the classifiers on
 * the error Supabase gave them; the page uses the reasons and the `?error=`
 * values to pick a message key.
 *
 * Security: a reason is one of a FIXED list. Nothing the user typed and
 * nothing from a Supabase body is ever copied into a message, so a code or a
 * token cannot leak, and a crafted `?error=` cannot print its own text.
 */
import type { MessageKey } from '@/lib/i18n';

/**
 * `bad_code` covers a code that is wrong AND a code that ran out (issue
 * 83-fix-wrong-code-says-expired). Supabase answers 403 for both and adds
 * `otp_expired` only some of the time, so splitting them is guesswork. One
 * reason means we never tell a student their fresh code expired.
 */
export type FailureReason = 'bad_code' | 'rate_limited' | 'failed';

const REASONS: readonly FailureReason[] = ['bad_code', 'rate_limited', 'failed'];

/** Supabase `error_code` values for the email rate limit. */
const RATE_LIMIT_CODES = ['over_email_send_rate_limit', 'over_request_rate_limit'];

/** What the browser client throws: the HTTP status and the reason the route gave. */
export class AuthRequestError extends Error {
  readonly status: number;
  readonly reason: FailureReason;

  constructor(status: number, reason: FailureReason = 'failed') {
    super('Auth request failed with status ' + status);
    this.name = 'AuthRequestError';
    this.status = status;
    this.reason = reason;
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status } = error as { status?: unknown };
  return typeof status === 'number' ? status : undefined;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function isRateLimited(error: unknown): boolean {
  const code = codeOf(error);
  return statusOf(error) === 429 || (code !== undefined && RATE_LIMIT_CODES.includes(code));
}

/**
 * A failed verify. Every refusal of the code itself is `bad_code`, whether
 * Supabase added `otp_expired` or not, so one message names both causes and
 * asks the student to check the code or resend it. Anything with no status
 * (a dead network) or a 5xx is a plain failure.
 */
export function classifyVerifyFailure(error: unknown): FailureReason {
  if (isRateLimited(error)) return 'rate_limited';
  const status = statusOf(error);
  if (status === 400 || status === 401 || status === 403 || status === 422) return 'bad_code';
  return 'failed';
}

/** A failed send. Only the rate limit gets its own message. */
export function classifySendFailure(error: unknown): 'rate_limited' | 'failed' {
  return isRateLimited(error) ? 'rate_limited' : 'failed';
}

/** A reason off a thrown error. Anything that is not ours is a plain failure. */
export function reasonOf(error: unknown): FailureReason {
  if (error instanceof AuthRequestError) return error.reason;
  return 'failed';
}

/** Parse a reason from a route body. Unknown values become `failed`. */
export function parseReason(value: unknown): FailureReason {
  return REASONS.find((reason) => reason === value) ?? 'failed';
}

const REASON_KEYS: Record<FailureReason, MessageKey> = {
  bad_code: 'auth.err.badCode',
  rate_limited: 'auth.err.rateLimited',
  failed: 'auth.failed',
};

export function reasonKey(reason: FailureReason): MessageKey {
  return REASON_KEYS[reason];
}

/** The five `?error=` values the Google callback sends. */
const QUERY_KEYS: Record<string, MessageKey> = {
  denied: 'auth.q.denied',
  no_code: 'auth.q.noCode',
  expired: 'auth.q.expired',
  failed: 'auth.q.failed',
  not_configured: 'auth.q.notConfigured',
};

/** The message key for a `?error=` value, or null for anything unknown. */
export function queryErrorKey(raw: unknown): MessageKey | null {
  if (typeof raw !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(QUERY_KEYS, raw) ? QUERY_KEYS[raw] : null;
}
