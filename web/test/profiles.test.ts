import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

type ProfileRow = { id: string; role: string; display_name: string | null; lang: string };

let db: TestDb;
let userA: string;
let userB: string;

beforeAll(async () => {
  db = await createTestDb();
  userA = await db.createUser();
  userB = await db.createUser();
  await db.admin.query(
    `insert into public.profiles (id, display_name, lang) values ($1, $2, 'en'), ($3, $4, 'hi')`,
    [userA, 'Asha', userB, 'Bharat'],
  );
});

afterAll(async () => {
  await db?.close();
});

describe('profiles RLS', () => {
  it('lets user A read their own profile (1 row)', async () => {
    const rows = await db.asUser(userA, async (sql) => {
      const r = await sql.query<ProfileRow>('select * from public.profiles');
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userA);
    expect(rows[0].display_name).toBe('Asha');
    expect(rows[0].role).toBe('student');
  });

  it("hides user B's profile from user A (0 rows)", async () => {
    const rows = await db.asUser(userA, async (sql) => {
      const r = await sql.query<ProfileRow>('select * from public.profiles where id = $1', [userB]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('lets user A edit their own display_name and lang', async () => {
    await db.asUser(userA, async (sql) => {
      await sql.query("update public.profiles set display_name = $1, lang = 'both' where id = $2", [
        'Asha K',
        userA,
      ]);
    });
    const r = await db.admin.query<ProfileRow>('select * from public.profiles where id = $1', [userA]);
    expect(r.rows[0].display_name).toBe('Asha K');
    expect(r.rows[0].lang).toBe('both');
  });

  it('stops user A from setting their own role to admin', async () => {
    await expect(
      db.asUser(userA, async (sql) => {
        await sql.query("update public.profiles set role = 'admin' where id = $1", [userA]);
      }),
    ).rejects.toThrow(/only an admin can change profiles\.role/i);

    const r = await db.admin.query<ProfileRow>('select role from public.profiles where id = $1', [userA]);
    expect(r.rows[0].role).toBe('student');
  });

  it('stops user A from changing user B\'s profile (0 rows updated)', async () => {
    const changed = await db.asUser(userA, async (sql) => {
      const r = await sql.query("update public.profiles set display_name = 'hacked' where id = $1", [
        userB,
      ]);
      return r.affectedRows ?? 0;
    });
    expect(changed).toBe(0);
    const r = await db.admin.query<ProfileRow>('select display_name from public.profiles where id = $1', [
      userB,
    ]);
    expect(r.rows[0].display_name).toBe('Bharat');
  });
});

describe('harness guard: RLS is really enforced under asUser', () => {
  it('returns 0 rows from a table that has RLS on and no policy', async () => {
    await db.admin.exec(`
      create table public.rls_guard_probe (id int primary key);
      alter table public.rls_guard_probe enable row level security;
      insert into public.rls_guard_probe (id) values (1), (2);
    `);

    // The owner role bypasses RLS, so the seed really is there.
    const asOwner = await db.admin.query('select * from public.rls_guard_probe');
    expect(asOwner.rows).toHaveLength(2);

    // Under asUser the role is `authenticated`, which must NOT bypass RLS.
    const asAuthed = await db.asUser(userA, async (sql) => {
      const r = await sql.query('select * from public.rls_guard_probe');
      return r.rows;
    });
    expect(asAuthed).toHaveLength(0);
  });

  it('runs queries as the authenticated role with auth.uid() set', async () => {
    const row = await db.asUser(userB, async (sql) => {
      const r = await sql.query<{ who: string; uid: string | null }>(
        'select current_user as who, auth.uid() as uid',
      );
      return r.rows[0];
    });
    expect(row.who).toBe('authenticated');
    expect(row.uid).toBe(userB);
  });

  it('resets the session back to the owner role after asUser', async () => {
    const r = await db.admin.query<{ who: string; uid: string | null }>(
      'select current_user as who, auth.uid() as uid',
    );
    expect(r.rows[0].who).not.toBe('authenticated');
    expect(r.rows[0].uid).toBeNull();
  });
});
