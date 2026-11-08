/**
 * The plumbing all three live checks share (issue 42-h3-live-check-tools).
 *
 * NODE ONLY, and deliberately NOT under `src/`: it reads `process.argv`,
 * `process.env` and the disk, so nothing the app bundles may import it. The
 * maths it calls lives in `@/lib/live-checks/core`, which is pure and tested.
 *
 * THE RULES THIS FILE EXISTS TO KEEP:
 *  * env is read inside a function, never at import time (web/CLAUDE.md);
 *  * a missing key prints ONE line and exits 1, never a stack trace;
 *  * no key value is ever printed, logged or written to a file;
 *  * every run writes its report under `web/live-checks/results/`, which is
 *    gitignored, and NEVER into the repo root `notes.md`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESULTS_DIR,
  readLiveCheckEnv,
  redactSecrets,
  resultFileName,
} from '@/lib/live-checks/core';
import { loadLocalEnv } from '../load-local-env';

/** `web/`, worked out from this file, so the tools run from any directory. */
export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Stop with one readable line and a non-zero exit.
 *
 * `console.error` plus `process.exit(1)`, never a thrown error: an unhandled
 * throw prints a stack trace, and a stack trace of a tool that holds two keys
 * is exactly the thing not to put on a terminal.
 */
export function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The keys this check needs, or stop. Names only, never values. */
export function requireEnv(need: readonly string[]): void {
  const check = readLiveCheckEnv({ need, env: process.env });
  if (!check.ok) stop(check.message);
}

// --------------------------------------------------------------------------
// Arguments
// --------------------------------------------------------------------------

export interface Args {
  /** Everything that is not a `--flag` or a flag's value. */
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * `node ... script.ts a.pdf --paper <id> --runs 2` into a small object.
 *
 * `process.argv.slice(2)`, so the first positional is the first real
 * argument. A flag with no value is `true`, which is how `--help` works.
 */
export function readArgs(argv: readonly string[] = process.argv.slice(2)): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const one = argv[i];
    if (!one.startsWith('--')) {
      positional.push(one);
      continue;
    }
    const name = one.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  return { positional, flags };
}

/** A flag's value as a string, or stop with the usage line. */
export function flagText(args: Args, name: string, usage: string): string {
  const value = args.flags[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    stop(`live check stopped: --${name} is required. ${usage}`);
  }
  return (value as string).trim();
}

/** A flag's value as a whole number inside a range, or the default. */
export function flagNumber(args: Args, name: string, fallback: number, min: number, max: number): number {
  const value = args.flags[name];
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    stop(`live check stopped: --${name} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid that is about to go in a URL filter, or stop. */
export function requireUuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) stop(`live check stopped: ${what} must be a uuid, not "${value}".`);
  return value;
}

// --------------------------------------------------------------------------
// The report
// --------------------------------------------------------------------------

/**
 * Print the report and save it under `web/live-checks/results/`.
 *
 * The file is written INSIDE `web/` and nowhere else. The repo root
 * `notes.md` is Boss's own page: these tools never touch it, they just print
 * a report Boss can copy from.
 *
 * Every secret it was told about is redacted first, and so is anything
 * key-shaped, because the probe's report carries the API's own error text.
 */
export async function publish(input: {
  name: string;
  report: string;
  date: Date;
  secrets?: readonly (string | undefined)[];
}): Promise<string> {
  const safe = redactSecrets(input.report, input.secrets ?? []);
  const folder = join(WEB_ROOT, RESULTS_DIR);
  const path = join(folder, resultFileName(input.name, input.date));

  await mkdir(folder, { recursive: true });
  await writeFile(path, safe, 'utf8');

  console.log(safe);
  console.log(`\nSaved to ${path}`);
  return path;
}

/**
 * True when THIS file is the script Node was asked to run.
 *
 * `process.argv[1]`, not `import.meta.url`: the jobs run through
 * `--import ./jobs/register-alias.mjs`, and comparing the resolved script
 * path is the form that survives a loader (same trick as `jobs/pdf-split.ts`).
 */
export function isEntryPoint(basename: string): boolean {
  const script = process.argv[1];
  if (typeof script !== 'string') return false;
  return new RegExp(`${basename}(\\.[cm]?[jt]s)?$`).test(script.replace(/\\/g, '/'));
}

/**
 * Run a check's `main` and turn any throw into one line plus exit 1.
 *
 * The message is redacted and the stack is dropped: a key could be in a
 * fetch error's cause, and a stack trace is not something Boss has to read.
 */
export function run(main: () => Promise<void>): void {
  // Keys live in web/.env.local (README). Plain node does not read it.
  loadLocalEnv();
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    stop('live check failed: ' + redactSecrets(message, [process.env.ANTHROPIC_API_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY]));
  });
}
