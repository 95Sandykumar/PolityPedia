/**
 * The admin screen's `PayoutsClient` over the Supabase REST API
 * (issue 29-ledger-reconcile-payouts).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the ADMIN'S OWN access token out of the
 * httpOnly session cookie. There is NO service-role key here, and that is the
 * point: `payout_report()` and `mark_payout_paid()` each check `is_admin()`
 * from `auth.uid()` inside Postgres, so a teacher calling this from a patched
 * build gets a refusal from the database, not a filtered answer.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body (a Postgres message quotes policy and constraint names, and
 * our own refusals quote a teacher id).
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  isPayoutPeriod,
  isUuid,
  type MarkPaidInput,
  type MarkPaidResult,
  type PayoutLine,
  type PayoutsClient,
} from './types';

const RPC = '/rest/v1/rpc/';

/** A bank reference is a short string from a human. */
const MAX_REFERENCE = 120;

export interface SupabasePayoutsClientOptions {
  /** The admin's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

interface ReportRow {
  teacher_id?: unknown;
  period?: unknown;
  sale_count?: unknown;
  amount?: unknown;
}

/**
 * PostgREST sends a `numeric` as a STRING, because a numeric(12,2) does not
 * survive a float round trip. Read back to a number only here, at the edge,
 * and only after checking it really is one: a NaN in a payout total is a
 * cheque nobody can sign.
 */
function readAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readCount(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** One report line, or null when any field is missing or the wrong shape. */
function readReportRow(raw: ReportRow): PayoutLine | null {
  if (!isUuid(raw?.teacher_id)) return null;
  if (!isPayoutPeriod(raw?.period)) return null;
  const saleCount = readCount(raw?.sale_count);
  const amountInr = readAmount(raw?.amount);
  // A line we cannot read is DROPPED, never shown with a guessed number. A
  // missing line is a payout Boss asks about; a wrong one is a wrong transfer.
  if (saleCount === null || amountInr === null) return null;
  return { teacherId: raw.teacher_id, period: raw.period, saleCount, amountInr };
}

export function createSupabasePayoutsClient(
  options: SupabasePayoutsClientOptions,
): PayoutsClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  function headers(): Record<string, string> {
    const { anonKey } = required();
    return {
      apikey: anonKey,
      authorization: 'Bearer ' + options.accessToken,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /**
     * The unpaid report.
     *
     * A failure THROWS rather than answering an empty list. An empty report
     * reads as "nothing owed", and a teacher waiting for last month's money is
     * not something a 500 gets to decide quietly.
     */
    async report(period: string | null = null) {
      const { url } = required();

      const res = await doFetch(`${url}${RPC}payout_report`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          // Anything that is not a month is sent as null, which means "every
          // month": a mistyped filter must not look like an empty month.
          for_period: isPayoutPeriod(period) ? period : null,
        }),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Supabase payout report failed with status ' + res.status);
      }

      const body = (await res.json()) as unknown;
      const raw = Array.isArray(body) ? (body as ReportRow[]) : [];
      const out: PayoutLine[] = [];
      for (const one of raw) {
        const found = readReportRow(one);
        if (found) out.push(found);
      }
      return out;
    },

    /** `mark_payout_paid()`. One transaction inside Postgres. */
    async markPaid({ teacherId, period, reference }: MarkPaidInput): Promise<MarkPaidResult> {
      const { url } = required();
      if (!isUuid(teacherId)) throw new Error('a payout needs a teacher id');
      if (!isPayoutPeriod(period)) throw new Error('a payout period must be YYYY-MM');

      const trimmed =
        typeof reference === 'string' ? reference.trim().slice(0, MAX_REFERENCE) : '';

      const res = await doFetch(`${url}${RPC}mark_payout_paid`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          for_teacher: teacherId,
          for_period: period,
          new_reference: trimmed.length > 0 ? trimmed : null,
        }),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Supabase mark payout paid failed with status ' + res.status);
      }

      const answer = (await res.json()) as unknown;
      // NULL means nothing was owed, which is a real answer and not an error:
      // the screen says "nothing to pay" instead of claiming a transfer.
      return { payoutId: isUuid(answer) ? answer : null };
    },
  };
}
