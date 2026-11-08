/**
 * The go-live preflight, all of it (issue 44-h5-golive-readiness).
 *
 * `jobs/golive-check.ts` is a sixty-line wrapper that reads the filesystem,
 * runs `pm2 jlist` and prints what this returns. Every decision is here,
 * because web/CLAUDE.md says `npm test` must run with no environment set, and
 * a file that reads `process.env` at the top cannot be imported by a test.
 *
 * READ ONLY. Nothing in the chain below writes anything, anywhere: no row, no
 * file, no Razorpay call. The one outside request is an unsigned POST at our
 * own webhook, which by design writes nothing (see `webhook-endpoint.ts`).
 *
 * THE KEY-MODE ROW IS COMPUTED LAST AND PRINTED SECOND. It has to be last,
 * because "live keys are a PASS only when every other money check passes"
 * cannot be known until the others have run. It has to be printed second,
 * because it is the row Boss is actually looking for.
 */
import type { Check, ExpectMode } from './types';
import { allClear, exitCodeFor } from './types';
import { parseArgs, readExpect } from './args';
import { checkCheckoutSrc, checkKeyMode, checkRazorpayEnv } from './keys';
import { checkGates, checkGoliveFile, parseGoliveFile } from './gates';
import { checkWebhookEndpoint, normaliseSite } from './webhook-endpoint';
import { checkMigration, checkOpenAlerts, checkServiceKey, latestMigration } from './supabase-checks';
import { checkPm2Config, checkPm2Online } from './pm2';
import { formatCheckTable, formatSummary } from './table';
import { createSupabaseGoliveReader, type GoliveReader } from './supabase-reader';

export { parseArgs, readExpect } from './args';
export { formatCheckTable, formatSummary } from './table';

export interface GoliveCheckDeps {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly reader?: GoliveReader;
  /** File names from `web/supabase/migrations/`, read by the job wrapper. */
  readonly migrationFiles?: readonly string[];
  /** `require('./ecosystem.config.cjs').apps`, read by the job wrapper. */
  readonly pm2Apps?: unknown;
  /** Parsed `npx pm2 jlist`, or null when pm2 could not be run. */
  readonly pm2Jlist?: unknown | null;
  /** The text of `web/golive.json`, or null when there is none. */
  readonly goliveJson?: string | null;
}

export interface GoliveCheckResult {
  readonly expect: ExpectMode;
  readonly checks: Check[];
  /** The whole table, ready to print. Holds no key and no secret. */
  readonly text: string;
  readonly exitCode: number;
}

/**
 * One preflight.
 *
 * A bad flag answers ONE check and exit 1 rather than throwing. The wrapper
 * then prints a sentence with no stack trace under it, which is what a tool
 * run at 11pm before a first sale has to do.
 */
export async function runGoliveCheck(deps: GoliveCheckDeps = {}): Promise<GoliveCheckResult> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(deps.argv ?? []);
  const wanted = readExpect(parsed.flags.expect);

  if (typeof wanted !== 'string') {
    const checks: Check[] = [
      {
        name: 'arguments',
        status: 'FAIL',
        detail: wanted.error,
        fix: 'from inside web/: node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect test   (use --expect live on the day)',
      },
    ];
    return { expect: 'test', checks, text: formatCheckTable(checks), exitCode: 1 };
  }

  const expect: ExpectMode = wanted;
  const reader = deps.reader ?? createSupabaseGoliveReader({ env, fetchImpl: deps.fetchImpl });
  const site =
    typeof parsed.flags.site === 'string'
      ? normaliseSite(parsed.flags.site)
      : normaliseSite(env.NEXT_PUBLIC_SITE_URL);
  const file = parseGoliveFile(deps.goliveJson ?? null);

  // Everything except the key mode. Sequential on purpose: two of these are
  // network calls and the output is a table somebody reads top to bottom, so
  // there is nothing to win by racing them and a clearer failure by not.
  const others: Check[] = [
    checkRazorpayEnv(env),
    checkCheckoutSrc(),
    await checkWebhookEndpoint({ siteUrl: site, fetchImpl: deps.fetchImpl }),
    await checkServiceKey(reader),
    await checkOpenAlerts(reader),
    await checkMigration(reader, latestMigration(deps.migrationFiles ?? [])),
    checkPm2Config(deps.pm2Apps),
    checkPm2Online(deps.pm2Jlist ?? null),
    ...checkGoliveFile(file, expect),
    ...checkGates(file, expect),
  ];

  const mode = checkKeyMode({ env, expect, othersClear: allClear(others) });

  // The mode row goes straight under the env row: that is the order Boss reads
  // in, and the two together are the whole "which world are we pointed at"
  // question.
  const checks = [others[0], mode, ...others.slice(1)];

  return {
    expect,
    checks,
    text: formatCheckTable(checks),
    exitCode: exitCodeFor(checks),
  };
}
