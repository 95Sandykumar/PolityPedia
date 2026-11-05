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
  ],
};
