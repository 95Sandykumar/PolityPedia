/**
 * An ANONYMOUS visitor and the public teacher view (issue 63-public-landing).
 *
 * A shared `/t/<id>` link arrives with no session cookie, so the read runs as
 * the `anon` role. This slice adds NO migration: it leans on the grant 0005
 * already wrote (`grant select on public.teachers_public to anon`). These
 * tests are the proof of that claim, and the guard that keeps design
 * constraint C true:
 *
 *  1. `anon` CAN read an approved teacher from the view (so the page can show
 *     a profile instead of a sign-in stub).
 *  2. `anon` sees the ALIAS, never the real name or the real photo.
 *  3. `anon` gets 0 rows from `public.teachers`, so the real name cannot leave
 *     Postgres even if a page asks for it by name.
 *  4. `anon` cannot see a teacher who is not approved yet.
 *  5. `anon` cannot WRITE through the view, which is auto-updatable and runs
 *     with its owner's rights.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asAnon` (Postgres
 * evaluates the grants and policies for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved, alias mode. The real name must never reach a visitor. */
let aliasTeacher: string;
/** Approved, public mode: this teacher chose to show their real name. */
let publicTeacher: string;
/** Redeemed an invite, still waiting for an admin. Invisible to everyone. */
let pendingTeacher: string;

const ALIAS_REAL_NAME = 'Rahul Sharma';
const ALIAS_NAME = 'Polity Guru';
const ALIAS_PHOTO = 'teachers/rahul.jpg';
const ALIAS_AVATAR = 'avatars/owl.png';
const PUBLIC_REAL_NAME = 'Meera Das';

type PublicRow = {
  user_id: string;
  identity_mode: string;
  display_name: string | null;
  avatar_path: string | null;
  bio_en: string | null;
  bio_hi: string | null;
  videos_visible: boolean;
};

async function seedTeacher(
  id: string,
  row: { identity_mode: string; status: string; real_name: string; alias: string },
): Promise<void> {
  await db.admin.query(
    `insert into public.teachers
       (user_id, identity_mode, real_name, alias, photo_path, alias_avatar, bio_en, bio_hi, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      row.identity_mode,
      row.real_name,
      row.alias,
      ALIAS_PHOTO,
      ALIAS_AVATAR,
      'Teaches polity',
      'राजनीति पढ़ाते हैं',
      row.status,
    ],
  );
}

beforeAll(async () => {
  db = await createTestDb();

  aliasTeacher = await db.createUser();
  publicTeacher = await db.createUser();
  pendingTeacher = await db.createUser();

  await seedTeacher(aliasTeacher, {
    identity_mode: 'alias',
    status: 'approved',
    real_name: ALIAS_REAL_NAME,
    alias: ALIAS_NAME,
  });
  await seedTeacher(publicTeacher, {
    identity_mode: 'public',
    status: 'approved',
    real_name: PUBLIC_REAL_NAME,
    alias: 'Hidden',
  });
  await seedTeacher(pendingTeacher, {
    identity_mode: 'alias',
    status: 'pending',
    real_name: 'Not Approved Yet',
    alias: 'Newcomer',
  });
});

afterAll(async () => {
  await db.close();
});

describe('a logged-out visitor reads teachers_public', () => {
  it('can read an approved teacher, so a shared link shows a real profile', async () => {
    const row = await db.asAnon(async (sql) => {
      const r = await sql.query<PublicRow>(
        'select * from public.teachers_public where user_id = $1',
        [publicTeacher],
      );
      return r.rows[0];
    });

    expect(row).toBeDefined();
    expect(row.display_name).toBe(PUBLIC_REAL_NAME);
  });

  it('sees the alias and the alias avatar for an alias teacher, nothing real', async () => {
    const row = await db.asAnon(async (sql) => {
      const r = await sql.query<PublicRow>(
        'select * from public.teachers_public where user_id = $1',
        [aliasTeacher],
      );
      return r.rows[0];
    });

    expect(row.display_name).toBe(ALIAS_NAME);
    expect(row.avatar_path).toBe(ALIAS_AVATAR);
    expect(JSON.stringify(row)).not.toContain(ALIAS_REAL_NAME);
    expect(JSON.stringify(row)).not.toContain(ALIAS_PHOTO);
  });

  it('lists approved teachers only: a pending one is not there', async () => {
    const ids = await db.asAnon(async (sql) => {
      const r = await sql.query<PublicRow>('select * from public.teachers_public');
      return r.rows.map((row) => row.user_id);
    });

    expect(ids).toContain(aliasTeacher);
    expect(ids).toContain(publicTeacher);
    expect(ids).not.toContain(pendingTeacher);
  });
});

describe('a logged-out visitor and the teachers table', () => {
  it('gets 0 rows from public.teachers: no policy covers anon', async () => {
    const rows = await db.asAnon(async (sql) => {
      const r = await sql.query('select * from public.teachers');
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('gets 0 rows even when it names the real_name column', async () => {
    const rows = await db.asAnon(async (sql) => {
      const r = await sql.query<{ real_name: string | null }>(
        'select real_name from public.teachers where user_id = $1',
        [aliasTeacher],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('cannot write through the view, which runs with its owner rights', async () => {
    await expect(
      db.asAnon(async (sql) => sql.query("update public.teachers_public set bio_en = 'hacked'")),
    ).rejects.toThrow();

    const stored = await db.admin.query<{ bio_en: string }>(
      'select bio_en from public.teachers where user_id = $1',
      [aliasTeacher],
    );
    expect(stored.rows[0].bio_en).toBe('Teaches polity');
  });
});
