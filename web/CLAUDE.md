@DESIGN.md

# PolityPedia web app conventions

- Specs: `../PRD-PolityPedia-v1.md` and `../design.md`. UI rules: `DESIGN.md` (tokens only, no raw hex in components, light only).
- Run `npm test` and `npm run build` inside `web/`. Both must pass with NO environment variables set.
- Every outside service (Supabase network calls, Claude, Razorpay, YouTube, TTS) sits behind a small interface and is faked in tests. No real network call and no real key in any test.
- Supabase and env access is lazy (read inside functions, never at import time), so the build works without env vars. Pages render a "not configured" state when keys are missing.
- SQL migrations live in `supabase/migrations/` and start with the issue number (example `0006_follows.sql` for issue 06), so parallel slices never collide. RLS is on for every table.
- DB tests use PGlite through `test/db.ts` (node env, `db` vitest project). See "Database tests" below.
- Every label a user sees exists in English and Hindi through `src/lib/i18n.ts` (modes `en | hi | both`, default `en`).
- Links use `prefetch={false}` (no viewport prefetch, B3).
- ESM imports use the `@/` alias for `src/`.

## Database tests

`test/db.ts` boots a real Postgres in memory (PGlite, WASM), stubs the parts of
Supabase that migrations depend on (schema `auth`, table `auth.users`,
`auth.uid()`, roles `anon` and `authenticated`), then applies every file in
`supabase/migrations/` in file-name order. Tests live in `test/*.test.ts` and
run in the `db` vitest project (node environment). Run them alone with:

```
npx vitest run --project db
```

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.close(); });

it('a user reads only their own row', async () => {
  const user = await db.createUser();                   // row in the auth.users stub
  await db.admin.query('insert into public.profiles (id) values ($1)', [user]);

  const rows = await db.asUser(user, async (sql) => {   // role authenticated, auth.uid() = user
    const r = await sql.query('select * from public.profiles');
    return r.rows;
  });
  expect(rows).toHaveLength(1);
});
```

| Member | What it does |
|---|---|
| `createTestDb()` | Boots PGlite, applies the Supabase stub, then every migration. |
| `db.admin` | Raw PGlite handle. Runs as the owner, so it **bypasses RLS**. Seed fixtures and assert stored state with it. |
| `db.createUser(id?)` | Inserts into the `auth.users` stub. Returns the user id. |
| `db.asUser(id, fn)` | Runs `fn` with `SET ROLE authenticated` and `auth.uid()` = `id`. |
| `db.asAnon(fn)` | Runs `fn` with `SET ROLE anon` and no `auth.uid()`. |
| `db.migrations` | File names that were applied, in order. |
| `db.close()` | Shuts the database down. Always call it in `afterAll`. |

Rules:

- RLS is enforced by Postgres, never faked in JS. `anon` and `authenticated` are
  not superusers and do not have BYPASSRLS, so every policy is evaluated for real.
  `test/profiles.test.ts` keeps a guard test that proves it: a table with RLS on
  and no policy returns 0 rows under `asUser`. Do not delete that test.
- Seed with `db.admin`, assert with `db.asUser`. Mixing them up is how a test
  passes while the policy is broken.
- PGlite is a single connection, so the session role is global. `asUser` and
  `asAnon` blocks are serialised and always reset the role afterwards, so never
  run `set role` yourself.
- A new table needs its own migration file prefixed with its issue number, plus
  `alter table ... enable row level security` and at least one policy.
