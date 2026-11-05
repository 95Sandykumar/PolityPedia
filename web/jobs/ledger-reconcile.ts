/**
 * P10, the nightly reconcile. The PM2 entry point
 * (issues 29-ledger-reconcile-payouts, 35-reconcile-visible).
 *
 * design.md A6: "Nightly reconcile: Razorpay payments vs `purchases`,
 * mismatch -> alert."
 *
 * THIS FILE IS ONLY WIRING. Every rule lives in `@/lib/ledger/reconcile`,
 * which is unit tested with a fake Razorpay and a fake store, because
 * `npm test` must run the whole of A6 with no network and no key
 * (web/CLAUDE.md), and a file that reads `process.env` at the top cannot be
 * imported by a test. The EXIT CODE is decided there too, by
 * `runReconcileJob`, for exactly the same reason.
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
 * With any of them missing the job reports what is missing BY NAME and exits
 * NON-ZERO (issue 35-reconcile-visible). It does not invent an all-clear
 * night: `runReconcile` reads neither side unless both are configured, because
 * reading one side alone would file every real sale as a mismatch.
 *
 * WHAT IT LOGS. One line, counts only: payments seen, subscription charges
 * skipped, purchases seen, purchase rows it could not read, mismatches, and
 * how many of those were new. Never a payment id, never an order id, never an
 * email, never a key. The ids live in the alert row, which only an admin can
 * read, on `/admin/alerts`.
 *
 * EXIT CODES, and this is the money part (issue 35-reconcile-visible).
 *
 *   0  THE TWO SIDES WERE COMPARED, however many alerts that found. An alert
 *      is the job WORKING, not the job failing, and a non-zero exit would make
 *      PM2 treat a caught money problem as a crash.
 *   1  IT COULD NOT CHECK: a key is missing, the Razorpay read threw, or the
 *      purchases read threw (which includes the 2,000-row cap).
 *
 * The old version exited 0 for "not configured" too. With
 * `stop_exit_codes: [0]` that meant a rotated Razorpay key made every night
 * check nothing while `pm2 list` showed a healthy, finished app. A silent
 * all-clear is the one answer this job must never give by accident.
 *
 * WHAT IS NOT HERE: a Telegram or email push. No other `jobs/*.ts` has an
 * admin notify path, and there is none anywhere under `web/`, so there was
 * nothing to reuse. 0029 already says pushing an alert to Boss is the
 * ClaudeClaw side, later. The alert row plus `/admin/alerts` is the delivery.
 */
import { createRazorpayPayments } from '@/lib/purchases/razorpay-payments';
import { runReconcileJob, type ReconcileJobResult } from '@/lib/ledger/reconcile';
import { createSupabaseReconcileStore } from '@/lib/ledger/supabase-reconcile-store';
import { EXIT_CANNOT_CHECK } from '@/lib/ledger/types';

/**
 * One night. Returns the exit code, so the caller owns `process` and a test
 * never has to.
 *
 * The adapters are injectable for the same reason, but nothing injects them
 * today: `runReconcileJob` is where the tests live.
 */
export async function main(
  input: Partial<Parameters<typeof runReconcileJob>[0]> = {},
): Promise<ReconcileJobResult> {
  const result = await runReconcileJob({
    payments: input.payments ?? createRazorpayPayments(),
    store: input.store ?? createSupabaseReconcileStore(),
    now: input.now,
    windowHours: input.windowHours,
  });

  // `console` is the PM2 log, which is the whole point. stderr for anything
  // that needs Boss, stdout for a routine night.
  if (result.loud) console.error(result.line);
  else console.log(result.line);

  return result;
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
  main()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      // `runReconcileJob` catches everything the reconcile throws, so reaching
      // here means the WIRING broke: a bad import, or an adapter factory that
      // threw. Still a night that checked nothing, so still non-zero.
      console.error(
        '[ledger-reconcile] could not start:',
        error instanceof Error ? error.message : 'unknown error',
      );
      process.exitCode = EXIT_CANNOT_CHECK;
    });
}
