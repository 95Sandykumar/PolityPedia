/**
 * Issue 03-sign-in, DB layer.
 * On first sign-in a profiles row must exist with role `student`.
 * Supabase creates the auth.users row; migration 0003 adds the trigger that
 * mirrors it into public.profiles, because 0002 has no insert policy on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('profile on signup', () => {
  it('ships migration 0003', () => {
    expect(db.migrations).toContain('0003_profile_on_signup.sql');
  });

  it('creates a profile with role student when an auth user appears', async () => {
    const user = await db.createUser();

    const { rows } = await db.admin.query<{ id: string; role: string; lang: string }>(
      'select id, role, lang from public.profiles where id = $1',
      [user],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('student');
    expect(rows[0].lang).toBe('en');
  });

  it('is idempotent: a second insert of the same id does not break the trigger', async () => {
    const user = await db.createUser();
    // Simulate the platform re-running the hook (upsert on auth.users).
    await db.admin.query(
      'insert into auth.users (id) values ($1) on conflict (id) do nothing',
      [user],
    );

    const { rows } = await db.admin.query('select id from public.profiles where id = $1', [user]);
    expect(rows).toHaveLength(1);
  });

  it('lets the new user read their own profile under RLS', async () => {
    const user = await db.createUser();

    const rows = await db.asUser(user, async (sql) => {
      const r = await sql.query<{ role: string }>('select role from public.profiles');
      return r.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('student');
  });

  it('does not let the user insert a profile row themselves (no insert policy)', async () => {
    const user = await db.createUser();
    // Clear the trigger's row so the insert can only fail on the missing policy,
    // not on the primary key.
    await db.admin.query('delete from public.profiles where id = $1', [user]);

    await expect(
      db.asUser(user, async (sql) => {
        await sql.query('insert into public.profiles (id) values ($1)', [user]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});
