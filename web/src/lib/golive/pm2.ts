/**
 * The two PM2 apps (issue 44-h5-golive-readiness).
 *
 * design.md D1/D2: the laptop jobs are PM2 apps, and every one of them sets
 * `CLAUDECODE: ''`. `web/ecosystem.config.cjs` already defines both and
 * already blanks it; the point of reading it here is that H5 is the ticket
 * where somebody edits that file under pressure, and a `CLAUDECODE` left at
 * `1` makes a job behave differently depending on who launched it.
 *
 * THE CONFIG CHECK AND THE RUNNING CHECK ARE SEPARATE, and they fail
 * differently on purpose:
 *
 *   config   is in the repo, so a wrong one is always a FAIL. It is a fact
 *            about a file this program can read with certainty.
 *   running  is a fact about ONE laptop. The preflight may be run from a
 *            different machine, or from CI, where `pm2` is not installed and
 *            could not tell the truth. That is MANUAL, not FAIL.
 *
 * NOTHING HERE SPAWNS ANYTHING. `npx pm2 jlist` is run by the thin job
 * wrapper, and its already-parsed JSON is passed in. A pure function cannot
 * hang a test on a process that does not exist.
 */
import type { Check } from './types';

/** `web/ecosystem.config.cjs`. H5 starts both. */
export const PM2_APPS = ['polity-pdf-split', 'polity-ledger'] as const;

/**
 * The cron job, which is `stopped` when it is HEALTHY.
 *
 * `stop_exit_codes: [0]` in the ecosystem file makes a finished night show as
 * `stopped` instead of `errored`. So `stopped` is the job working, and
 * demanding `online` here would make every clean night look like a problem.
 */
const CRON_APPS = new Set<string>(['polity-ledger']);

interface AppShape {
  name?: unknown;
  env?: unknown;
}

function readApps(apps: unknown): AppShape[] | null {
  if (!Array.isArray(apps)) return null;
  return apps as AppShape[];
}

export function checkPm2Config(apps: unknown): Check {
  const name = 'PM2 config';
  const list = readApps(apps);

  if (list === null) {
    return {
      name,
      status: 'FAIL',
      detail: 'web/ecosystem.config.cjs did not give an apps array',
      fix: 'check web/ecosystem.config.cjs still exports { apps: [...] }',
    };
  }

  const problems: string[] = [];
  const found: string[] = [];

  for (const wanted of PM2_APPS) {
    const app = list.find((one) => one?.name === wanted);
    if (!app) {
      problems.push(wanted + ' is not defined');
      continue;
    }
    found.push(wanted);

    const env = app.env;
    if (typeof env !== 'object' || env === null) {
      problems.push(wanted + ' has no env block, so CLAUDECODE is not blanked (design D1)');
      continue;
    }
    const claudecode = (env as Record<string, unknown>).CLAUDECODE;
    if (claudecode === undefined) {
      problems.push(wanted + ' does not set CLAUDECODE (design D1)');
    } else if (claudecode !== '') {
      problems.push(wanted + ' sets CLAUDECODE to something that is not blank (design D1)');
    }
  }

  if (problems.length > 0) {
    return {
      name,
      status: 'FAIL',
      detail: problems.join('; '),
      fix: "every app in web/ecosystem.config.cjs needs env: { CLAUDECODE: '' }, so a job is the same job whoever started it",
    };
  }

  return {
    name,
    status: 'PASS',
    detail: found.join(' and ') + " are defined, both with CLAUDECODE blanked",
  };
}

interface JlistShape {
  name?: unknown;
  pm2_env?: unknown;
}

/**
 * `npx pm2 jlist`, already parsed. `null` means pm2 could not be run.
 */
export function checkPm2Online(jlist: unknown | null): Check {
  const name = 'PM2 running';
  const startLine =
    'npx pm2 start web/ecosystem.config.cjs --only polity-pdf-split && npx pm2 start web/ecosystem.config.cjs --only polity-ledger';

  if (jlist === null || jlist === undefined) {
    return {
      name,
      status: 'MANUAL',
      detail: 'pm2 is not installed here, or jlist could not be read, so this says nothing about the laptop',
      fix: 'on the laptop that runs the jobs: ' + startLine + ', then `npx pm2 ls`',
    };
  }

  if (!Array.isArray(jlist)) {
    return {
      name,
      status: 'MANUAL',
      detail: 'pm2 jlist did not answer with a list',
      fix: 'run `npx pm2 jlist` by hand and read it, then ' + startLine,
    };
  }

  const list = jlist as JlistShape[];
  const problems: string[] = [];
  const states: string[] = [];

  for (const wanted of PM2_APPS) {
    const app = list.find((one) => one?.name === wanted);
    if (!app) {
      problems.push(wanted + ' has never been started');
      continue;
    }
    const env = app.pm2_env;
    const state =
      typeof env === 'object' && env !== null
        ? String((env as Record<string, unknown>).status ?? 'unknown')
        : 'unknown';
    states.push(wanted + ' ' + state);

    if (state === 'online') continue;
    // A cron app that has finished its night is `stopped`, and that is fine.
    if (CRON_APPS.has(wanted) && state === 'stopped') continue;
    problems.push(wanted + ' is ' + state);
  }

  if (problems.length > 0) {
    return {
      name,
      status: 'FAIL',
      detail: problems.join('; ') + (states.length > 0 ? ' (seen: ' + states.join(', ') + ')' : ''),
      fix: startLine + ', then `npx pm2 logs <name> --lines 50` to see why it stopped',
    };
  }

  return { name, status: 'PASS', detail: states.join(', ') };
}
