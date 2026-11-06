/**
 * Browser-side `BrowserAlertsClient` (issue 35-reconcile-visible).
 *
 * The page never holds a Supabase key and never sees a token. It calls our own
 * route handler; that handler reads the admin's access token out of the
 * httpOnly session cookie and lets the `reconcile_alerts_admin_all` policy in
 * Postgres decide.
 *
 * Security: the error message is fixed, so a Postgres policy name is never
 * echoed back into the page.
 */
import {
  ADMIN_ALERTS_PATH,
  isUuid,
  type BrowserAlertsClient,
  type ReconcileAlertRow,
} from './types';

/**
 * The longest `kind` the table can hold
 * (issue 38-session-and-alerts-fixes).
 *
 * A stale LIST of kinds used to live here, and it dropped every row whose kind
 * was not on it, which hid the three kinds the webhook writes (0034). The
 * screen names the kinds; this file only checks the shape.
 */
const MAX_KIND_LENGTH = 40;

interface ListReply {
  alerts?: unknown;
}

interface ResolveReply {
  resolved?: unknown;
}

function paise(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/** One row, or null. The same shape check the server already did. */
function readAlert(raw: unknown): ReconcileAlertRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, kind, subject, orderId, expectedPaise, actualPaise, createdAtIso } =
    raw as Record<string, unknown>;
  if (!isUuid(id)) return null;
  // Shape only: a kind this build cannot name still draws as a generic row.
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_KIND_LENGTH) return null;
  if (typeof subject !== 'string' || subject.length === 0) return null;
  if (typeof createdAtIso !== 'string' || createdAtIso.length === 0) return null;
  return {
    id,
    kind,
    subject,
    orderId: typeof orderId === 'string' && orderId.length > 0 ? orderId : null,
    expectedPaise: paise(expectedPaise),
    actualPaise: paise(actualPaise),
    createdAtIso,
  };
}

export function createBrowserAlertsClient(fetchImpl?: typeof fetch): BrowserAlertsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async list() {
      const res = await doFetch(ADMIN_ALERTS_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Alerts read failed with status ' + res.status);

      const body = (await res.json()) as ListReply;
      const raw = Array.isArray(body?.alerts) ? body.alerts : [];
      const out: ReconcileAlertRow[] = [];
      for (const one of raw) {
        const found = readAlert(one);
        // A row we cannot read is DROPPED, never drawn with a guessed amount:
        // Boss decides about real money from this screen.
        if (found) out.push(found);
      }
      return out;
    },

    async resolve(id: string) {
      const res = await doFetch(ADMIN_ALERTS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error('Resolving the alert failed with status ' + res.status);

      const body = (await res.json()) as ResolveReply;
      return body?.resolved === true;
    },
  };
}
