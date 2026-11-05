/**
 * PM2 apps for PolityPedia (issue 12-pdf-split-worker).
 *
 * design.md D1/D2: the laptop jobs are PM2 apps, and every one of them sets
 * `CLAUDECODE: ''`.
 *
 * WHY `CLAUDECODE: ''` MATTERS. PM2 inherits the environment of whatever
 * started it. When that is a Claude Code session, `CLAUDECODE=1` is in the
 * environment, and any Anthropic tool the job runs would then believe it is
 * inside an interactive agent session: it changes defaults, it can look for a
 * terminal that is not there, and it makes a job behave differently depending
 * on who launched it. Blanking it makes the job the same job every time.
 *
 * `.cjs`, not `.js`: `web/` has no `"type"` in package.json but Next.js tools
 * treat its config as ESM, and PM2 reads this file with `require`. The `.cjs`
 * extension removes the guesswork.
 *
 * THIS IS NOT STARTED BY THIS ISSUE. The live run against the real Claude API
 * is ticket H3. To start it by hand later:
 *
 *   npx pm2 start web/ecosystem.config.cjs --only polity-pdf-split
 *   npx pm2 logs polity-pdf-split
 *   npx pm2 stop polity-pdf-split
 *
 * The three secrets are NOT in this file. PM2 reads them from the shell that
 * starts it, or from `web/.env.local` through the dotenv loader below, so no
 * key is ever committed.
 */

module.exports = {
  apps: [
    {
      name: 'polity-pdf-split',
      // Plain `node`. Node 22+ runs TypeScript by stripping the types, and
      // `register-alias.mjs` teaches it the `@/` alias, so the worker runs
      // exactly the files the tests cover: no build step, no bundled second
      // copy that could drift. Same command as `npm run job:pdf-split`.
      interpreter: 'node',
      interpreter_args: '--import ./jobs/register-alias.mjs',
      script: 'jobs/pdf-split.ts',
      cwd: __dirname,

      // ONE instance. design.md D1/D5: 1 job at a time, and the teacher is
      // waiting, so a second worker would only race for the same row. The
      // claim in 0012 is atomic anyway, which makes this a cost rule rather
      // than a correctness one.
      instances: 1,
      exec_mode: 'fork',

      // It is a long-running listener, not a cron job: it must come back if it
      // dies, and it must not come back in a tight loop if it dies at startup.
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 5,
      restart_delay: 10_000,

      // The worker holds one 30 MB PDF plus its base64 copy at a time, so
      // 512 MB is generous. A number this low catches a leak instead of
      // letting the laptop swap.
      max_memory_restart: '512M',

      // Never on a timer. The worker has its own 5-minute sweep and a Realtime
      // listener; a cron restart would kill a split in flight.
      cron_restart: null,

      env: {
        NODE_ENV: 'production',
        // D2. See the note at the top of this file.
        CLAUDECODE: '',
      },

      merge_logs: true,
      time: true,
    },

    // -----------------------------------------------------------------------
    // P10, the nightly reconcile (issue 29-ledger-reconcile-payouts).
    //
    // design.md A6: Razorpay payments versus our `purchases`, and a row in
    // `reconcile_alerts` for anything that does not line up.
    //
    // THIS IS NOT STARTED BY THIS ISSUE. To start it by hand later:
    //
    //   npx pm2 start web/ecosystem.config.cjs --only polity-ledger
    //   npx pm2 logs polity-ledger
    //   npx pm2 stop polity-ledger
    //
    // Or run one night in the foreground, without PM2:
    //
    //   npm run job:ledger-reconcile
    //
    // Its four secrets are NOT in this file. PM2 reads them from the shell
    // that starts it, or from `web/.env.local`, so no key is ever committed.
    // -----------------------------------------------------------------------
    {
      name: 'polity-ledger',
      // Same interpreter and alias loader as the split worker, so the job runs
      // exactly the files the tests cover: no build step, no second copy.
      interpreter: 'node',
      interpreter_args: '--import ./jobs/register-alias.mjs',
      script: 'jobs/ledger-reconcile.ts',
      cwd: __dirname,

      instances: 1,
      exec_mode: 'fork',

      // design.md D5: "P10 at 2 AM CST". PM2's cron follows the clock of the
      // laptop PM2 runs on, so `0 2 * * *` is 2 AM CST exactly as long as that
      // laptop is on CST, which is Boss's. NOT pinned to a timezone here on
      // purpose: an hour the job thinks is 2 AM and the laptop thinks is
      // something else is a job that fires while Boss is using the machine.
      //
      // The HOUR barely matters anyway, and that is the point of the 48-hour
      // window: it does not have to catch a boundary, it just has to run.
      cron_restart: '0 2 * * *',

      // IT IS A CRON JOB, NOT A LISTENER, and that is the whole reason for
      // the next three lines. The job compares 48 hours, writes what it found
      // and exits 0.
      //
      //  * `autorestart: false` -- a finished night must not be started again
      //    a second later. The cron is what brings it back.
      //  * `stop_exit_codes: [0]` -- tells PM2 that exit 0 is the job DONE,
      //    so the app shows as `stopped` and not as `errored`. Without it
      //    every clean night looks like a crash in `pm2 list`.
      //  * no `min_uptime` / `max_restarts` -- those are restart-loop guards,
      //    and there is no restart to guard.
      //
      // A non-zero exit (the run itself broke, not "it found alerts") is left
      // alone on purpose: tomorrow's 2 AM retries it, and the 48-hour window
      // means one skipped night loses nothing.
      autorestart: false,
      stop_exit_codes: [0],

      // It holds one night of payments and purchases as plain objects. 256 MB
      // is already generous; a number this low catches a runaway page loop
      // instead of letting the laptop swap.
      max_memory_restart: '256M',

      env: {
        NODE_ENV: 'production',
        // D2. See the note at the top of this file.
        CLAUDECODE: '',
      },

      merge_logs: true,
      time: true,
    },
  ],
};
