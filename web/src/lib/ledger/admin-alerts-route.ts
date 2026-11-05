/**
 * The decision logic behind /api/admin/alerts (issue 35-reconcile-visible).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `admin-payouts-route.ts`. The route file is a thin adapter.
 *
 * WHY THIS ROUTE EXISTS. The nightly job has been writing `reconcile_alerts`
 * since issue 29 and nothing outside the job ever read the table: a money
 * problem found at 2 AM waited for somebody to open a database console. This
 * is the human end of it.
 *
 * Order of checks matters: session, then role, then config, then the body. A
 * teacher who is not an admin gets the same 403 whether or not Supabase is set
 * up, so this route cannot be used to probe the deployment.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `reconcile_alerts_admin_all` policy in 0029, evaluated against the admin's
 * OWN access token, so a teacher calling this from a patched build gets zero
 * rows from Postgres rather than a filtered page. Replies carry a fixed
 * message, never a thrown error, so a policy name, a constraint name or
 * somebody's payment id never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { isUuid, type AlertsClient, type ReconcileAlertRow } from './types';

export interface AdminAlertsInput {
  method: 'GET' | 'POST';
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: AlertsClient;
}

export interface AdminAlertsReply {
  status: number;
  body: { alerts: ReconcileAlertRow[] } | { resolved: boolean } | { error: string };
}

function fail(status: number, error: string): AdminAlertsReply {
  return { status, body: { error } };
}

export async function handleAdminAlerts({
  method,
  body,
  session,
  client,
}: AdminAlertsInput): Promise<AdminAlertsReply> {
  if (!session) return fail(401, 'sign in');
  // A teacher is shut out as firmly as a student: an alert subject names
  // another teacher's sale.
  if (session.role !== 'admin') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  if (method === 'GET') {
    try {
      return { status: 200, body: { alerts: await client.listOpen() } };
    } catch {
      // Fixed message: the thrown error may quote Postgres. An EMPTY LIST is
      // not an option here, because "nothing is wrong" and "I could not look"
      // are opposite answers and one of them is money.
      return fail(502, 'read failed');
    }
  }

  if (typeof body !== 'object' || body === null) return fail(400, 'bad request');
  const fields = body as Record<string, unknown>;

  // Checked HERE as well as in Postgres, so a mistyped id costs no round trip
  // and comes back as a refusal rather than a constraint name.
  if (!isUuid(fields.id)) return fail(400, 'bad request');

  try {
    // FALSE is a real answer, not an error: the row was already resolved, so
    // somebody else got there first. The screen says so instead of claiming a
    // decision it did not make.
    return { status: 200, body: { resolved: await client.resolve(fields.id) } };
  } catch {
    return fail(502, 'save failed');
  }
}
