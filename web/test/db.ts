/**
 * PGlite test harness for PolityPedia (issue 02-db-harness).
 *
 * Starts a real Postgres (PGlite, WASM) in memory, stubs the parts of Supabase
 * that migrations and RLS policies depend on, then applies every file in
 * `supabase/migrations/` in name order.
 *
 * RLS is enforced by Postgres itself, never faked in JS: `asUser()` does
 * `SET ROLE authenticated`, and that role has no BYPASSRLS, so every policy is
 * evaluated for real. See `test/profiles.test.ts` for the guard test that proves it.
 *
 * `asService()` is the THIRD role, and it is not a convenience: a function
 * granted to `service_role` alone is a different security claim from one
 * granted to `authenticated`, and the only way to test that claim is to hold
 * both keys. See `test/ai-finish-server-only.test.ts`
 * (issue 41-ai-finish-server-only).
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));

/** The claim Supabase puts the signed-in user id in, and `auth.uid()` reads back. */
const JWT_SUB = 'request.jwt.claim.sub';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The slice of Supabase our migrations assume already exists.
 * Everything here is created by the Supabase platform in a real project, so it
 * must NOT live in a migration file.
 */
const SUPABASE_STUB = `
  -- Roles. Neither API role is a superuser and neither has BYPASSRLS, so RLS
  -- is real for every student request.
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;

  -- The SERVER-ONLY role, exactly as a real Supabase project has it: it
  -- BYPASSES RLS, which is why its key never leaves our server. Functions
  -- granted to this role alone (the webhook ones in 0027, the AI finish and
  -- fail in 0040) are unreachable from a browser. That is the whole point.
  create role service_role nologin noinherit bypassrls;

  create schema if not exists auth;
  grant usage on schema auth to anon, authenticated, service_role;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    created_at timestamptz not null default now()
  );

  -- The signed-in user id, or NULL when nobody is signed in.
  create function auth.uid() returns uuid
    language sql stable
  as $$
    select nullif(current_setting('${JWT_SUB}', true), '')::uuid
  $$;

  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Supabase grants the API roles access to the public schema, and sets default
  -- privileges so every table a later migration creates is reachable too.
  --
  -- service_role is in these lists because a real Supabase project puts it
  -- there. That is WHY a migration that wants a function to be server-only
  -- has to spell out its REVOKEs: the default grant has already handed
  -- EXECUTE to anon and authenticated by the time the migration ends.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant execute on functions to anon, authenticated, service_role;
`;

export interface TestDb {
  /**
   * Raw handle. Runs as the database owner, which bypasses RLS.
   * Use it to seed fixtures and to assert what is really stored.
   */
  readonly admin: PGlite;
  /** Names of the migration files that were applied, in the order they ran. */
  readonly migrations: readonly string[];
  /** Insert a row into the `auth.users` stub. Returns the user id. */
  createUser(id?: string): Promise<string>;
  /** Run `fn` with role `authenticated` and `auth.uid()` = `id`. */
  asUser<T>(id: string, fn: (sql: PGlite) => Promise<T>): Promise<T>;
  /** Run `fn` with role `anon` and no `auth.uid()` (a visitor who is not signed in). */
  asAnon<T>(fn: (sql: PGlite) => Promise<T>): Promise<T>;
  /**
   * Run `fn` with role `service_role` and NO `auth.uid()`.
   *
   * This is our own server holding `SUPABASE_SERVICE_ROLE_KEY`: the webhook,
   * the nightly job, and the AI finish/fail calls. A service-role token has
   * no `sub` claim, so `auth.uid()` is NULL here, which is exactly why a
   * server-only function may not depend on it.
   */
  asService<T>(fn: (sql: PGlite) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Read `supabase/migrations/*.sql` sorted by file name (so `0002_` runs before `0010_`). */
export async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const names = (await readdir(MIGRATIONS_DIR))
    .filter((n) => n.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(MIGRATIONS_DIR + name, 'utf8') })),
  );
}

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUB);

  const migrations = await readMigrations();
  for (const { name, sql } of migrations) {
    try {
      await db.exec(sql);
    } catch (cause) {
      await db.close();
      throw new Error(`migration ${name} failed: ${(cause as Error).message}`, { cause });
    }
  }

  // PGlite is one connection, so session state (role + claim) is global.
  // Serialise asUser/asAnon blocks so two of them can never overlap.
  let lock: Promise<unknown> = Promise.resolve();

  async function withSession<T>(role: 'authenticated' | 'anon' | 'service_role', uid: string | null, fn: (sql: PGlite) => Promise<T>) {
    const run = lock.then(async () => {
      await db.exec(`set role ${role}`);
      await db.query(`select set_config($1, $2, false)`, [JWT_SUB, uid ?? '']);
      try {
        return await fn(db);
      } finally {
        await db.exec('reset role');
        await db.query(`select set_config($1, '', false)`, [JWT_SUB]);
      }
    });
    lock = run.catch(() => undefined);
    return run;
  }

  return {
    admin: db,
    migrations: migrations.map((m) => m.name),

    async createUser(id?: string) {
      const userId = id ?? randomUuid();
      assertUuid(userId);
      await db.query(`insert into auth.users (id) values ($1)`, [userId]);
      return userId;
    },

    asUser(id, fn) {
      assertUuid(id);
      return withSession('authenticated', id, fn);
    },

    asAnon(fn) {
      return withSession('anon', null, fn);
    },

    asService(fn) {
      return withSession('service_role', null, fn);
    },

    close() {
      return db.close();
    },
  };
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

function assertUuid(id: string): void {
  if (!UUID_RE.test(id)) throw new Error(`not a uuid: ${JSON.stringify(id)}`);
}
