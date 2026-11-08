/**
 * The three Supabase rows of the preflight table
 * (issue 44-h5-golive-readiness).
 *
 *   1. the service-role key works,
 *   2. `reconcile_alerts` has nothing open,
 *   3. the newest migration file is applied.
 *
 * WHY AN OPEN ALERT BLOCKS GO-LIVE. design.md A6: the nightly reconcile
 * compares Razorpay against our `purchases` and files a row for anything that
 * does not line up. An open row means the last night of TEST money did not
 * add up. Switching to live keys on top of that is taking real money through
 * a path that is already known to be wrong.
 *
 * WHY A READ THAT BROKE IS A WARN AND NOT A FAIL. A Supabase blip and "there
 * are three unresolved money alerts" are different facts, and reporting the
 * first as the second is how a tool teaches Boss to ignore it. The exit code
 * stays 0 and the row says plainly that it could not look.
 */
import type { Check } from './types';
import type { GoliveReader } from './supabase-reader';

/**
 * The newest migration, by its numeric prefix.
 *
 * `supabase/migrations/` in this repo is named `0034_webhook_grant_first.sql`:
 * the issue number, not a Supabase CLI timestamp (web/CLAUDE.md). So the
 * `version` that lands in `supabase_migrations.schema_migrations` is that same
 * four-digit prefix, and the prefix is what the comparison uses.
 */
export function latestMigration(
  fileNames: readonly string[],
): { file: string; version: string } | null {
  let best: { file: string; version: string; value: number } | null = null;
  for (const file of fileNames) {
    const match = /^(\d+)_.*\.sql$/.exec(file);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (best === null || value > best.value) best = { file, version: match[1], value };
  }
  return best === null ? null : { file: best.file, version: best.version };
}

export async function checkServiceKey(reader: GoliveReader): Promise<Check> {
  const name = 'Supabase service key';

  if (!reader.isConfigured()) {
    return {
      name,
      status: 'FAIL',
      detail: 'NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing',
      fix: 'put both into web/.env.local; the service key is SERVER ONLY and must never get a NEXT_PUBLIC_ prefix',
    };
  }

  let answer: { ok: boolean; status: number };
  try {
    answer = await reader.ping();
  } catch {
    return {
      name,
      status: 'WARN',
      detail: 'the read threw before it got an answer',
      fix: 'check this machine is online and the Supabase project is not paused',
    };
  }

  if (answer.ok) {
    return { name, status: 'PASS', detail: 'one service-role read of reconcile_alerts worked' };
  }
  if (answer.status === 0) {
    return {
      name,
      status: 'WARN',
      detail: 'could not reach the Supabase project',
      fix: 'check this machine is online and the Supabase project is not paused',
    };
  }
  return {
    name,
    status: 'FAIL',
    detail: 'a service-role read of reconcile_alerts answered ' + answer.status,
    fix: 'check SUPABASE_SERVICE_ROLE_KEY is the service_role key from Supabase (Project, Settings, API) and not the anon key',
  };
}

export async function checkOpenAlerts(reader: GoliveReader): Promise<Check> {
  const name = 'reconcile alerts';

  let rows: Awaited<ReturnType<GoliveReader['openAlerts']>>;
  try {
    rows = await reader.openAlerts();
  } catch {
    return {
      name,
      status: 'WARN',
      detail: 'could not read reconcile_alerts, so it is unknown whether any are open',
      fix: 'run the preflight again; if it keeps failing, open /admin/alerts and read the list by hand',
    };
  }

  if (rows.length === 0) {
    return { name, status: 'PASS', detail: '0 open rows' };
  }

  // Counted BY KIND, because the kind is what tells Boss what to do, and
  // because the subject can hold a payment id, which does not belong in a
  // terminal somebody screenshots.
  const byKind = new Map<string, number>();
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  const listed = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => kind + ' ' + count)
    .join(', ');

  return {
    name,
    status: 'FAIL',
    detail: rows.length + ' open rows: ' + listed,
    fix: 'open /admin/alerts, fix or resolve every row, and do not switch to live keys until it is empty',
  };
}

export async function checkMigration(
  reader: GoliveReader,
  latest: { file: string; version: string } | null,
): Promise<Check> {
  const name = 'latest migration';

  if (latest === null) {
    return {
      name,
      status: 'MANUAL',
      detail: 'no migration files were found to compare',
      fix: 'run this from inside web/, so supabase/migrations/ can be read',
    };
  }

  const sql = 'select version from supabase_migrations.schema_migrations order by version desc limit 5;';

  let answer: Awaited<ReturnType<GoliveReader['migrationApplied']>>;
  try {
    answer = await reader.migrationApplied(latest.version);
  } catch {
    answer = 'unreadable';
  }

  if (answer === 'yes') {
    return { name, status: 'PASS', detail: latest.file + ' (version ' + latest.version + ') is applied' };
  }

  if (answer === 'no') {
    return {
      name,
      status: 'FAIL',
      detail: latest.file + ' (version ' + latest.version + ') is NOT in schema_migrations',
      fix: 'run `npx supabase db push` from the repo root, then run this preflight again',
    };
  }

  // 'unreadable'. PostgREST only reaches schemas a project has exposed, and
  // `supabase_migrations` is not exposed by default. There is no Postgres
  // driver in this repo's dependencies, so SUPABASE_DB_URL cannot be queried
  // from here either, and installing one for a preflight is not worth it: the
  // honest answer is one line of SQL Boss can paste.
  return {
    name,
    status: 'MANUAL',
    detail:
      'supabase_migrations.schema_migrations is not readable over the REST API; newest local file is ' +
      latest.file,
    fix:
      'paste this into the Supabase SQL editor (or `psql "$SUPABASE_DB_URL" -c` if that is set) and look for ' +
      latest.version +
      ': ' +
      sql,
  };
}
