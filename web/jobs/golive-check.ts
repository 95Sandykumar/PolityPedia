/**
 * The go-live preflight. The entry point (issue 44-h5-golive-readiness).
 *
 * Human ticket H5: before the first real sale, Boss has to clear X1, X3, X4,
 * X8, B9, AS6 and Razorpay KYC, switch to live keys, start both PM2 apps, and
 * prove the money path with one Rs 299 purchase and a refund. This file turns
 * the automatic half of that into one table and one exit code.
 *
 * READ ONLY. It writes nothing: no row, no file, no Razorpay call. The one
 * outside request is an UNSIGNED POST at our own webhook, which by design
 * refuses and stores nothing (see `src/lib/golive/webhook-endpoint.ts`).
 *
 * HOW TO RUN IT, from inside `web/`:
 *
 *   node --import ./jobs/register-alias.mjs jobs/golive-check.ts
 *   node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect live
 *   node --import ./jobs/register-alias.mjs jobs/golive-check.ts --site https://politypedia.vercel.app
 *
 * Flags:
 *   --expect test   the default, and what is true today. Test keys are a WARN
 *                   and an unsigned gate is a MANUAL, so the exit code is 0.
 *   --expect live   go-live day. Test keys and any unsigned gate become FAIL.
 *   --site <url>    which deployment to poke. Falls back to
 *                   NEXT_PUBLIC_SITE_URL, then to the Vercel URL.
 *
 * Exit code: 1 if ANY row says FAIL, else 0. MANUAL and WARN do not fail the
 * run, because every manual gate is open today and an exit code that is
 * always 1 tells nobody anything.
 *
 * THIS FILE IS ONLY WIRING. Every rule lives in `@/lib/golive/preflight`,
 * which is unit tested with a fake fetch and a fake reader, because
 * web/CLAUDE.md says `npm test` must run with no environment set, and a file
 * that reads `process.env` at the top cannot be imported by a test.
 *
 * Env it reads (all optional for the run itself; missing ones become FAIL rows
 * with their own names in them):
 *
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
 *   RAZORPAY_PLAN_PRO_ID, RAZORPAY_PLAN_AI_ID   (subscriptions only)
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   NEXT_PUBLIC_SITE_URL
 *
 * NO VALUE IS EVER PRINTED. Not a key, not a secret, not a token. The table
 * says "set" or "missing", and for the key pair it says `test`, `live` or
 * `mixed`, which is a fact about the first nine characters of a key id.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runGoliveCheck, type GoliveCheckResult } from '@/lib/golive/preflight';

const HERE = join(import.meta.dirname, '..');

/**
 * `web/.env.local`, when Node can load one.
 *
 * `process.loadEnvFile` is built into Node 22, which is the Node this repo
 * already needs for TypeScript type stripping. There is no dotenv dependency
 * and this adds none. Wrapped, because a missing file is the normal case on a
 * machine that puts its keys in the shell instead.
 */
function loadLocalEnv(): void {
  try {
    const load = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
    if (typeof load === 'function') load.call(process, join(HERE, '.env.local'));
  } catch {
    // No file, or no permission. Both are fine: the shell may hold the keys.
  }
}

/** The migration file names, so the newest can be compared to the database. */
function migrationFiles(): string[] {
  try {
    return readdirSync(join(HERE, 'supabase', 'migrations'));
  } catch {
    return [];
  }
}

/** `web/ecosystem.config.cjs`'s apps array, or null. */
function pm2Apps(): unknown {
  try {
    const require = createRequire(import.meta.url);
    const config = require(join(HERE, 'ecosystem.config.cjs')) as { apps?: unknown };
    return config?.apps ?? null;
  } catch {
    return null;
  }
}

/** `web/golive.json`, or null when Boss has not made one yet. */
function goliveJson(): string | null {
  try {
    return readFileSync(join(HERE, 'golive.json'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * `npx --no-install pm2 jlist`, parsed, or null.
 *
 * `--no-install` on purpose: a preflight must never download a package. If pm2
 * is not already here the answer is null, the row says MANUAL, and nothing was
 * installed behind Boss's back.
 *
 * `shell: true` because on Windows `npx` is a `.cmd` and cannot be spawned
 * directly. The whole command is ONE string with an EMPTY args array, because
 * passing args alongside `shell: true` is deprecated in Node (DEP0190) and
 * concatenates them unescaped anyway. Nothing here comes from user input.
 */
function pm2Jlist(): unknown | null {
  try {
    const run = spawnSync('npx --no-install pm2 jlist', [], {
      cwd: HERE,
      encoding: 'utf8',
      shell: true,
      timeout: 30_000,
      // pm2's own chatter goes nowhere; only stdout is read.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (run.status !== 0 || typeof run.stdout !== 'string') return null;
    // pm2 sometimes prints a banner before the JSON, so take from the first [.
    const start = run.stdout.indexOf('[');
    if (start < 0) return null;
    return JSON.parse(run.stdout.slice(start)) as unknown;
  } catch {
    return null;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<GoliveCheckResult> {
  loadLocalEnv();

  const result = await runGoliveCheck({
    argv,
    env: process.env,
    migrationFiles: migrationFiles(),
    pm2Apps: pm2Apps(),
    pm2Jlist: pm2Jlist(),
    goliveJson: goliveJson(),
  });

  const head = 'PolityPedia go-live preflight, expecting ' + result.expect.toUpperCase() + ' keys';
  const body = head + '\n\n' + result.text;

  // stderr when something failed, stdout when it did not, so a shell can tell
  // the two apart without reading the table.
  if (result.exitCode === 0) console.log(body);
  else console.error(body);

  return result;
}

/**
 * Started only when this file is the process entry point, so a test or a tool
 * can import `main` without running a preflight.
 *
 * `process.argv[1]` and not `import.meta.url`: the same shape as
 * `jobs/pdf-split.ts` and `jobs/ledger-reconcile.ts`, which survives being
 * run through a loader.
 */
const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /golive-check(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isEntryPoint) {
  main()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      // `runGoliveCheck` turns every check failure into a table row, so
      // reaching here means the WIRING broke: a bad import, or a filesystem
      // read that threw outside its guard. ONE LINE, and no stack: a stack
      // trace in front of Boss at 11pm before a first sale helps nobody, and
      // a thrown Supabase error can carry a URL.
      console.error(
        '[golive-check] could not run:',
        error instanceof Error ? error.message : 'unknown error',
      );
      process.exitCode = 1;
    });
}
