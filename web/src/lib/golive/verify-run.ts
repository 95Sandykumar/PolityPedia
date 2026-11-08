/**
 * The test-purchase verifier, all of it (issue 44-h5-golive-readiness).
 *
 * `jobs/verify-test-purchase.ts` is a thin wrapper that prints what this
 * returns. The rules live in `verify.ts`; this file only finds the purchase
 * and reads the five things around it.
 *
 * READ ONLY, like the preflight. Every call it makes is a GET.
 *
 * WHY IT TAKES THREE SPELLINGS OF ONE SALE. On go-live day Boss is looking at
 * the Razorpay dashboard, and what is on that screen is a PAYMENT id
 * (`pay_...`). Our own tables know the ORDER id (`order_...`) and the purchase
 * uuid. A tool that demanded the one id Boss does not have in front of them
 * would get used once.
 *
 * EVERY FAILURE IS A TABLE ROW, NEVER A THROW. A verifier run minutes after a
 * real Rs 299 purchase must answer in words: a stack trace tells Boss nothing
 * about whether the teacher got their share.
 */
import type { Check } from './types';
import { exitCodeFor } from './types';
import { parseArgs, readAmount } from './args';
import { formatCheckTable } from './table';
import { verifyTestPurchase } from './verify';
import {
  createSupabaseGoliveReader,
  type EventRow,
  type GoliveReader,
  type PurchaseRow,
} from './supabase-reader';

/** The Rs 299 of H5's own "test that proves it". Overridden by --amount. */
export const DEFAULT_TEST_AMOUNT_INR = 299;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;

export interface VerifyRunDeps {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly reader?: GoliveReader;
}

export interface VerifyRunResult {
  readonly checks: Check[];
  /** The whole table, ready to print. Holds no key and no secret. */
  readonly text: string;
  readonly exitCode: number;
}

function one(check: Check): VerifyRunResult {
  return { checks: [check], text: formatCheckTable([check]), exitCode: exitCodeFor([check]) };
}

/** A read error as a sentence. Never a stack, never a response body. */
function readFailed(what: string, error: unknown): VerifyRunResult {
  const message = error instanceof Error ? error.message : 'the read failed';
  return one({
    name: 'Supabase read',
    status: 'FAIL',
    detail: 'could not read ' + what + ': ' + message,
    fix: 'check the Supabase project is awake and SUPABASE_SERVICE_ROLE_KEY is the service_role key, then run this again',
  });
}

/** The Razorpay order id named in the same payload as this payment id. */
function orderIdForPayment(events: readonly EventRow[], paymentId: string): string | null {
  for (const event of events) {
    let json: string;
    try {
      json = JSON.stringify(event.payload ?? null);
    } catch {
      continue;
    }
    if (!json.includes('"' + paymentId + '"')) continue;
    const match = /"order_id"\s*:\s*"(order_[A-Za-z0-9]{1,40})"/.exec(json);
    if (match) return match[1];
  }
  return null;
}

export async function runVerifyTestPurchase(deps: VerifyRunDeps = {}): Promise<VerifyRunResult> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(deps.argv ?? []);
  const reader = deps.reader ?? createSupabaseGoliveReader({ env, fetchImpl: deps.fetchImpl });

  const wanted = parsed.positional[0]?.trim() ?? '';
  if (wanted === '') {
    return one({
      name: 'arguments',
      status: 'FAIL',
      detail: 'name the sale: a purchase uuid, a Razorpay order id (order_...) or a payment id (pay_...)',
      fix: 'from inside web/: node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts pay_XXXXXXXXXXXX   (add --refunded after the refund)',
    });
  }

  const amount = readAmount(parsed.flags.amount, DEFAULT_TEST_AMOUNT_INR);
  if (typeof amount !== 'number') {
    return one({
      name: 'arguments',
      status: 'FAIL',
      detail: amount.error,
      fix: 'pass whole rupees, for example --amount 299',
    });
  }

  if (!reader.isConfigured()) {
    return one({
      name: 'Supabase service key',
      status: 'FAIL',
      detail: 'NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing',
      fix: 'put both into web/.env.local and run this from inside web/; the service key is SERVER ONLY and must never get a NEXT_PUBLIC_ prefix',
    });
  }

  // ---- find the sale -------------------------------------------------------
  //
  // The event list is read FIRST, before the purchase, because the payment-id
  // path needs it to find the purchase at all: `purchases` does not store a
  // payment id, only the order id. The other two paths need the same list a
  // moment later for the `payment_events` check, so it is one read either way.
  let events: EventRow[];
  try {
    events = await reader.recentEvents();
  } catch (error) {
    return readFailed('payment_events', error);
  }

  let purchase: PurchaseRow | null = null;
  let how: string;
  try {
    if (UUID.test(wanted)) {
      how = 'purchase id';
      purchase = await reader.purchaseById(wanted);
    } else if (ORDER_ID.test(wanted)) {
      how = 'Razorpay order id';
      purchase = await reader.purchaseByOrderId(wanted);
    } else if (PAYMENT_ID.test(wanted)) {
      how = 'Razorpay payment id';
      const order = orderIdForPayment(events, wanted);
      if (order === null) {
        return one({
          name: 'purchase found',
          status: 'FAIL',
          detail: 'no payment_events row names that payment id, so there is no order id to look up',
          fix: 'the webhook never arrived for this payment. Check the Razorpay dashboard webhook URL and its secret, then read the Vercel logs for /api/webhooks/razorpay',
        });
      }
      purchase = await reader.purchaseByOrderId(order);
    } else {
      return one({
        name: 'arguments',
        status: 'FAIL',
        detail: '"' + wanted + '" is not a purchase uuid, an order_... id or a pay_... id',
        fix: 'copy the payment id from the Razorpay dashboard, it starts pay_',
      });
    }
  } catch (error) {
    return readFailed('purchases', error);
  }

  if (purchase === null) {
    return one({
      name: 'purchase found',
      status: 'FAIL',
      detail: 'no purchases row for that ' + how,
      fix: 'check the id, and check this is pointed at the right Supabase project',
    });
  }

  // ---- read everything around it ------------------------------------------
  let ledger: Awaited<ReturnType<GoliveReader['ledgerRows']>>;
  let access: Awaited<ReturnType<GoliveReader['accessRows']>>;
  let openAlerts: Awaited<ReturnType<GoliveReader['openAlerts']>>;
  try {
    ledger = await reader.ledgerRows(purchase.id);
  } catch (error) {
    return readFailed('teacher_ledger', error);
  }
  try {
    access = await reader.accessRows(purchase.userId, purchase.setId);
  } catch (error) {
    return readFailed('set_access', error);
  }
  try {
    openAlerts = await reader.openAlerts();
  } catch (error) {
    return readFailed('reconcile_alerts', error);
  }

  // The teacher and the exam come from the SET, exactly as grant_purchase()
  // takes them (V19). A failure here is not fatal: the share comparison turns
  // into a WARN and the X2 window falls back to 12 months, which is what the
  // SQL does with no announced date anyway.
  let sharePct: number | null = null;
  let nextExamDate: string | null = null;
  try {
    const owner = await reader.setOwner(purchase.setId);
    if (owner) {
      sharePct = await reader.teacherSharePct(owner.teacherId);
      if (owner.examId) nextExamDate = await reader.nextExamDate(owner.teacherId, owner.examId);
    }
  } catch {
    sharePct = null;
    nextExamDate = null;
  }

  const checks = verifyTestPurchase({
    purchase,
    ledger,
    access,
    events,
    openAlerts,
    teacherSharePct: sharePct,
    nextExamDate,
    expectedAmountInr: amount,
    refunded: parsed.flags.refunded === true || parsed.flags.refunded === 'true',
  });

  const header = [
    'purchase ' + purchase.id,
    'order ' + (purchase.orderId ?? '(none, Rs 0 path)'),
    'found by ' + how,
    'expecting Rs ' + amount + (parsed.flags.refunded ? ', refunded' : ''),
  ].join(' | ');

  return {
    checks,
    text: header + '\n\n' + formatCheckTable(checks),
    exitCode: exitCodeFor(checks),
  };
}
