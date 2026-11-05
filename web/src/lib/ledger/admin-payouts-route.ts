/**
 * The decision logic behind /api/admin/payouts
 * (issue 29-ledger-reconcile-payouts).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `admin-set-access-route.ts`. The route file is a thin adapter.
 *
 * Order of checks matters: session, then role, then config, then the body. A
 * teacher who is not an admin gets the same 403 whether or not Supabase is set
 * up, so this route cannot be used to probe the deployment.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `is_admin()` check inside `payout_report()` and `mark_payout_paid()`, which
 * reads the admin's own access token. Replies carry a fixed message, never a
 * thrown error, so a policy name, a constraint name or a teacher id never
 * reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { isPayoutPeriod, isUuid, type PayoutLine, type PayoutsClient } from './types';

export interface AdminPayoutsInput {
  method: 'GET' | 'POST';
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** The `period` query parameter on a GET, if there was one. */
  period?: string | null;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: PayoutsClient;
}

export interface AdminPayoutsReply {
  status: number;
  body: { lines: PayoutLine[] } | { payoutId: string | null } | { error: string };
}

function fail(status: number, error: string): AdminPayoutsReply {
  return { status, body: { error } };
}

/** A bank reference is a short note from a human, or nothing at all. */
const MAX_REFERENCE = 120;

function readReference(body: Record<string, unknown>): string | null {
  const { reference } = body;
  if (typeof reference !== 'string') return null;
  const trimmed = reference.trim().slice(0, MAX_REFERENCE);
  return trimmed.length > 0 ? trimmed : null;
}

export async function handleAdminPayouts({
  method,
  body,
  period,
  session,
  client,
}: AdminPayoutsInput): Promise<AdminPayoutsReply> {
  if (!session) return fail(401, 'sign in');
  if (session.role !== 'admin') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  if (method === 'GET') {
    try {
      // A `period` that is not a month becomes null, which means EVERY month.
      // A mistyped filter must not look like a month with nothing owed.
      const lines = await client.report(isPayoutPeriod(period) ? period : null);
      return { status: 200, body: { lines } };
    } catch {
      // Fixed message: the thrown error may quote Postgres.
      return fail(502, 'read failed');
    }
  }

  if (typeof body !== 'object' || body === null) return fail(400, 'bad request');
  const fields = body as Record<string, unknown>;

  // Both are checked HERE as well as in Postgres. A bad month would otherwise
  // cost a round trip and come back as a constraint name, and two spellings of
  // one month are two payouts for the same sales.
  if (!isUuid(fields.teacherId)) return fail(400, 'bad request');
  if (!isPayoutPeriod(fields.period)) return fail(400, 'bad request');

  const reference = readReference(fields);

  try {
    const result = await client.markPaid({
      teacherId: fields.teacherId,
      period: fields.period,
      reference,
    });
    // A null id is a real answer: nothing was owed, so nothing was paid. The
    // screen says so rather than claiming a transfer that did not happen.
    return { status: 200, body: { payoutId: result.payoutId } };
  } catch {
    return fail(502, 'save failed');
  }
}
