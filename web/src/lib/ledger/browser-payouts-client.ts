/**
 * Browser-side `BrowserPayoutsClient` (issue 29-ledger-reconcile-payouts).
 *
 * The page never holds a Supabase key and never sees a token. It calls our own
 * route handler; that handler reads the admin's access token out of the
 * httpOnly session cookie and lets the `is_admin()` guard inside Postgres
 * decide.
 *
 * Security: the error message is fixed, so a Postgres policy name is never
 * echoed back into the page.
 */
import {
  ADMIN_PAYOUTS_PATH,
  isPayoutPeriod,
  isUuid,
  type BrowserPayoutsClient,
  type MarkPaidInput,
  type MarkPaidResult,
  type PayoutLine,
} from './types';

interface ReportReply {
  lines?: unknown;
}

interface MarkPaidReply {
  payoutId?: unknown;
}

/** One line, or null. The same shape check the server already did. */
function readLine(raw: unknown): PayoutLine | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { teacherId, period, saleCount, amountInr } = raw as Record<string, unknown>;
  if (!isUuid(teacherId) || !isPayoutPeriod(period)) return null;
  if (typeof saleCount !== 'number' || !Number.isInteger(saleCount) || saleCount < 0) return null;
  if (typeof amountInr !== 'number' || !Number.isFinite(amountInr) || amountInr < 0) return null;
  return { teacherId, period, saleCount, amountInr };
}

export function createBrowserPayoutsClient(fetchImpl?: typeof fetch): BrowserPayoutsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async list() {
      const res = await doFetch(ADMIN_PAYOUTS_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Payout report failed with status ' + res.status);

      const body = (await res.json()) as ReportReply;
      const raw = Array.isArray(body?.lines) ? body.lines : [];
      const out: PayoutLine[] = [];
      for (const one of raw) {
        const found = readLine(one);
        // A line we cannot read is DROPPED, never drawn with a guessed amount:
        // the number on this screen is the number Boss types into a bank.
        if (found) out.push(found);
      }
      return out;
    },

    async markPaid({ teacherId, period, reference }: MarkPaidInput): Promise<MarkPaidResult> {
      const res = await doFetch(ADMIN_PAYOUTS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId, period, reference: reference ?? null }),
      });
      if (!res.ok) throw new Error('Mark payout paid failed with status ' + res.status);

      const body = (await res.json()) as MarkPaidReply;
      return { payoutId: isUuid(body?.payoutId) ? body.payoutId : null };
    },
  };
}
