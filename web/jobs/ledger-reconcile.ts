/**
 * P10, the nightly reconcile. The PM2 entry point
 * (issue 29-ledger-reconcile-payouts).
 *
 * design.md A6: "Nightly reconcile: Razorpay payments vs `purchases`,
 * mismatch -> alert."
 *
 * THIS FILE IS ONLY WIRING. Every rule lives in `@/lib/ledger/reconcile`,
 * which is unit tested with a fake Razorpay and a fake store, because
 * `npm test` must run the whole of A6 with no network and no key
 * (web/CLAUDE.md), and a file that reads `process.env` at the top cannot be
 * imported by a test.
 *
 * IT RUNS ONCE AND EXITS. Unlike the PDF split worker, which listens, this is
 * a cron job: PM2 starts it at 2 AM, it compares the last 48 hours, it writes
 * what it found, and it stops. `stop_exit_codes: [0]` in the ecosystem file is
 * what tells PM2 that a clean exit is the job finishing and not the job
 * crashing, so PM2 does not restart-loop it between nights.
 *
 * HOW TO RUN IT (do NOT start it as part of this issue):
 *
 *   npx pm2 start web/ecosystem.config.cjs --only polity-ledger
 *   npx pm2 logs polity-ledger
 *
 * Or once, by hand, to see a night:
 *
 *   node --import ./jobs/register-alias.mjs jobs/ledger-reconcile.ts
 *
 * Env it needs, all laptop only:
 *
 *   NEXT_PUBLIC_SUPABASE_URL       the project URL (not a secret)
 *   SUPABASE_SERVICE_ROLE_KEY      bypasses RLS, because a cron job is no user
 *   RAZORPAY_KEY_ID                the public half
 *   RAZORPAY_KEY_SECRET            a secret
 *
 * With any of them missing the job reports "not configured" and exits 0. It
 * does NOT invent an all-clear night: `runReconcile` reads neither side unless
 * both are configured, because reading one side alone would file every real
 * sale as a mismatch.
 *
 * WHAT IT LOGS. One line, counts only: payments seen, purchases seen,
 * mismatches, and how many of those were new. Never a payment id, never an
 * order id, never an email, never a key. The ids live in the alert row, which
 * only an admin can read.
 *
 * EXIT CODES. 0 for a finished night, however many alerts it wrote: an alert
 * is the job WORKING, not the job failing, and a non-zero exit would make PM2
 * treat a caught problem as a crash. 1 only when the run itself broke, so a
 * silent night of nothing is impossible to confuse with success.
 */
import { createRazorpayPayments } from '@/lib/purchases/razorpay-payments';
import { runReconcile } from '@/lib/ledger/reconcile';
import { createSupabaseReconcileStore } from '@/lib/ledger/supabase-reconcile-store';
import { RECONCILE_WINDOW_HOURS, type ReconcileOutcome } from '@/lib/ledger/types';

/** One short line per run. `console` is the PM2 log, which is the whole point. */
function report(outcome: ReconcileOutcome): void {
  if (outcome.type === 'idle') {
    console.error('[ledger-reconcile] not configured, nothing checked');
    return;
  }
  const line =
    `[ledger-reconcile] window=${RECONCILE_WINDOW_HOURS}h` +
    ` payments=${outcome.payments} purchases=${outcome.purchases}` +
    ` alerts=${outcome.alerts} new=${outcome.fresh}`;
  // A new mismatch goes to stderr so it stands out in `pm2 logs`. A repeat
  // sighting is routine: Boss has already been told.
  if (outcome.fresh > 0) console.error(line);
  else console.log(line);
}

export async function main(): Promise<ReconcileOutcome> {
  const payments = createRazorpayPayments();
  const store = createSupabaseReconcileStore();

  // Every missing key by NAME, never by value: a key in a log file is a
  // leaked key.
  const missing = [
    payments.isConfigured() ? null : 'RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET',
    store.isConfigured() ? null : 'NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error(`[ledger-reconcile] not configured. Missing: ${missing.join(', ')}`);
  }

  const outcome = await runReconcile({ payments, store });
  report(outcome);
  return outcome;
}

/**
 * Started only when this file is the process entry point, so a test or a tool
 * can import `main` without running a night.
 *
 * `process.argv[1]` instead of `import.meta.url`: PM2 may run this through a
 * loader, and comparing the resolved script path is the form that survives it.
 * Same shape as `jobs/pdf-split.ts`.
 */
const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /ledger-reconcile(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    // The message only. A thrown error from the store carries an HTTP status
    // and nothing else by design, but a future one might carry more.
    console.error(
      '[ledger-reconcile] run failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    process.exitCode = 1;
  });
}
