/**
 * Prove the Rs 299 test sale really worked. The entry point
 * (issue 44-h5-golive-readiness).
 *
 * H5's own "test that proves it" is: one real Rs 299 purchase, then a refund,
 * with the ledger row and the reconcile both right. This is the tool that
 * reads whether they are, so Boss does not have to open five tables in the
 * Supabase editor with a card statement in the other hand.
 *
 * READ ONLY. Every call it makes is a GET. It cannot fix anything, which is
 * the point: a verifier that could write is a verifier nobody trusts.
 *
 * HOW TO RUN IT, from inside `web/`:
 *
 *   node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts pay_RxxxxxxxxxxxxX
 *   node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts order_RxxxxxxxxxxxxX
 *   node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts <purchase uuid>
 *
 * After the refund, the same command plus `--refunded`.
 * For a set that is not Rs 299, add `--amount 399`.
 *
 * Any of the three ids works, because the id in front of Boss on go-live day
 * is the PAYMENT id from the Razorpay dashboard, and our own tables only know
 * the order id and the purchase uuid.
 *
 * What it checks, all read off the migrations (see `@/lib/golive/verify`):
 *
 *   purchase status      paid, or refunded with --refunded (A3, forward only)
 *   purchase amount      Rs 299, or whatever --amount says
 *   one ledger row       exactly one, per teacher_ledger_purchase_unique
 *   ledger split         gst, fee, net, teacher and platform to the paisa
 *   share copied         share_pct is the sale-time COPY (X3)
 *   buyer access         set_access source=purchase, ending where X2 says
 *   payment_events row   the webhook's audit row, once
 *   reconcile alerts     nothing unresolved for this sale
 *   refund path          with --refunded: refund_purchase() really ran
 *
 * Exit code: 1 if ANY row says FAIL, else 0.
 *
 * THIS FILE IS ONLY WIRING. Every rule lives in `@/lib/golive/verify` and
 * `@/lib/golive/verify-run`, both unit tested against fake rows with no key
 * and no network (web/CLAUDE.md).
 *
 * Env it needs:
 *   NEXT_PUBLIC_SUPABASE_URL    the project URL (not a secret)
 *   SUPABASE_SERVICE_ROLE_KEY   bypasses RLS, because a tool is no user
 *
 * With either missing it prints ONE line naming both, exits 1, and shows no
 * stack trace. No key, no token and no payment secret is ever printed.
 */
import { runVerifyTestPurchase, type VerifyRunResult } from '@/lib/golive/verify-run';
import { loadLocalEnv } from './load-local-env';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<VerifyRunResult> {
  loadLocalEnv();

  const result = await runVerifyTestPurchase({ argv, env: process.env });

  if (result.exitCode === 0) console.log(result.text);
  else console.error(result.text);

  return result;
}

/** Started only when this file is the process entry point. */
const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /verify-test-purchase(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isEntryPoint) {
  main()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      // `runVerifyTestPurchase` turns every read failure into a table row, so
      // reaching here means the wiring broke. ONE line, no stack.
      console.error(
        '[verify-test-purchase] could not run:',
        error instanceof Error ? error.message : 'unknown error',
      );
      process.exitCode = 1;
    });
}
