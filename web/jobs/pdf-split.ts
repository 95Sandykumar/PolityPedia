/**
 * P9, the PDF split worker. The PM2 entry point (issue 12-pdf-split-worker).
 *
 * design.md P9: "teacher uploads PDF to Storage -> row in `ingest_jobs`
 * (status queued). P9 listens on Realtime for new rows (sweep every 5 min as
 * fallback) -> sends PDF to Haiku with a strict JSON schema -> writes
 * `questions` as `draft` -> job `done`. Teacher's review screen updates live
 * from the job row. Cap: 1 job at a time, 200 questions, 3 retries, then
 * `failed` with the error shown to the teacher."
 *
 * THIS FILE IS ONLY WIRING. It builds the four real services and hands them to
 * the two pieces that hold the logic, both of which are unit tested with
 * fakes:
 *
 *   `@/lib/split/worker`  runOnce()           -- one job, start to finish
 *   `@/lib/split/runner`  createSplitRunner() -- when to call it, 1 at a time
 *
 * The split is kept that way on purpose: `npm test` must run the whole P9
 * behaviour with no network, no key and no PDF (web/CLAUDE.md), and a file
 * that reads `process.env` at the top cannot be imported by a test.
 *
 * HOW TO RUN IT (do NOT start it as part of this issue):
 *
 *   npx pm2 start web/ecosystem.config.cjs --only polity-pdf-split
 *   npx pm2 logs polity-pdf-split
 *
 * Env it needs, all laptop only:
 *
 *   NEXT_PUBLIC_SUPABASE_URL       the project URL (not a secret)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY  Storage sends it next to the auth header
 *   SUPABASE_SERVICE_ROLE_KEY      bypasses RLS, because the worker is no user
 *   ANTHROPIC_API_KEY              spends money
 *
 * With any of them missing the worker still STARTS and reports "not
 * configured", then idles. It does not crash and it does not fail a teacher's
 * job: a job lost to a missing env var would be a teacher's upload thrown
 * away, and PM2 would restart-loop on the crash.
 *
 * WHAT IT LOGS. One line per finished job: the job id, the outcome and the
 * count. Never the PDF, never a stem, never a key, never a storage path. The
 * error reason is one of the `SplitFailure` codes, which is already safe to
 * read, because a model's own words could repeat what a hostile PDF told it
 * to say (design constraint C).
 */
import { createSupabaseFileStore } from '@/lib/papers/supabase-file-store';
import { readAnthropicKey, readServiceEnv } from '@/lib/split/env';
import { createHaikuSplitter } from '@/lib/split/haiku-splitter';
import { createSplitRunner } from '@/lib/split/runner';
import { createSupabaseJobFeed } from '@/lib/split/supabase-job-feed';
import { createSupabaseSplitStore } from '@/lib/split/supabase-split-store';
import { runOnce, type SplitOutcome } from '@/lib/split/worker';

/** One short line per job. `console` is the PM2 log, which is the whole point. */
function report(outcome: SplitOutcome): void {
  if (outcome.type === 'idle') return;
  if (outcome.type === 'done') {
    console.log(
      `[pdf-split] job=${outcome.jobId} done questions=${outcome.questionCount} attempts=${outcome.attempts}`,
    );
    return;
  }
  console.error(
    `[pdf-split] job=${outcome.jobId} failed reason=${outcome.error} attempts=${outcome.attempts}`,
  );
}

export function main(): () => void {
  const service = readServiceEnv();

  const store = createSupabaseSplitStore();
  const splitter = createHaikuSplitter();
  // The service-role key in place of a user's access token: Storage policies
  // would otherwise refuse the worker, which owns no folder. The URL and the
  // ANON key still have to be set, because `supabase-file-store.ts` reads them
  // for the request itself.
  const files = createSupabaseFileStore({ accessToken: service?.serviceRoleKey ?? '' });
  const feed = createSupabaseJobFeed();

  /**
   * Every missing key, by NAME, never by value: a key in a log file is a
   * leaked key.
   *
   * All three services are asked, not just the two obvious env vars. `runOnce`
   * returns `idle` when any one of them is unconfigured, so a worker that
   * started with the file store misconfigured would sit there reporting
   * nothing at all while a teacher waited. That is the exact failure this
   * block exists to make loud.
   */
  const missing = [
    service ? null : 'NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY',
    readAnthropicKey() ? null : 'ANTHROPIC_API_KEY',
    files.isConfigured() ? null : 'NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY',
    store.isConfigured() ? null : 'the split store env',
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error(`[pdf-split] not configured, idling. Missing: ${missing.join(', ')}`);
    return () => undefined;
  }

  const runner = createSplitRunner({
    runOnce: () => runOnce({ store, splitter, files }),
    feed,
    onOutcome: report,
    // A thrown error means the store itself is unreachable. The runner keeps
    // going and the 5-minute sweep retries, so a Supabase blip is a pause and
    // not a restart loop.
    onError: (error) =>
      console.error(
        '[pdf-split] run failed:',
        error instanceof Error ? error.message : 'unknown error',
      ),
  });

  console.log('[pdf-split] watching ingest_jobs, sweeping every 5 minutes');
  return runner.start();
}

/**
 * Started only when this file is the process entry point, so a test or a tool
 * can import `main` without launching a worker.
 *
 * `process.argv[1]` instead of `import.meta.url`: PM2 may run this through a
 * loader, and comparing the resolved script path is the form that survives it.
 */
const isEntryPoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /pdf-split(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isEntryPoint) {
  const stop = main();
  // PM2 sends SIGINT on `pm2 stop` and SIGTERM on `pm2 delete`. Both leave the
  // socket closed and the sweep cleared; `stop` is safe to call twice.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log('[pdf-split] stopping');
      stop();
      process.exit(0);
    });
  }
}
