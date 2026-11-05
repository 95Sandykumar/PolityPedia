/**
 * Teachers: invite, approval and alias privacy (issue 05-teacher-invite-approval).
 *
 * The four proofs the issue asks for:
 *  1. privacy: as a student, no query returns `real_name` of an alias teacher.
 *  2. a teacher cannot change their own `revenue_share_pct` or `status` (V19).
 *  3. a used invite code cannot be used twice.
 *  4. an admin approve sets `status = approved`.
 *
 * v0 privacy rule: alias mode is enforced by a DB view plus RLS, never by the
 * UI. A student has NO select policy on `public.teachers`, so the real name
 * cannot leave the database even if a page asks for it.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher in alias mode. Real name must never reach a student. */
let aliasTeacher: string;
/** Approved teacher who chose to show their real name. */
let publicTeacher: string;
/** Redeemed an invite, still waiting for an admin. */
let pendingTeacher: string;
/** A plain student. The attacker in every privacy test here. */
let student: string;
/** The only role that may set `status` and `revenue_share_pct`. */
let admin: string;

const ALIAS_REAL_NAME = 'Rahul Sharma';
const ALIAS_NAME = 'Polity Guru';
const PUBLIC_REAL_NAME = 'Meera Das';

type TeacherRow = {
  user_id: string;
  identity_mode: string;
  real_name: string | null;
  alias: string | null;
  photo_path: string | null;
  alias_avatar: string | null;
  status: string;
  approved_by: string | null;
  videos_visible: boolean;
  revenue_share_pct: number;
};

type PublicRow = {
  user_id: string;
  identity_mode: string;
  display_name: string | null;
  avatar_path: string | null;
  bio_en: string | null;
  bio_hi: string | null;
  videos_visible: boolean;
};

/** Make an admin without tripping 0002's role-change trigger: replace the row. */
async function makeAdmin(id: string): Promise<void> {
  await db.admin.query('delete from public.profiles where id = $1', [id]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [id]);
}

async function seedTeacher(
  id: string,
  row: Partial<TeacherRow> & { identity_mode: string; status: string },
): Promise<void> {
  await db.admin.query(
    `insert into public.teachers
       (user_id, identity_mode, real_name, alias, photo_path, alias_avatar, bio_en, bio_hi, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      row.identity_mode,
      row.real_name ?? null,
      row.alias ?? null,
      row.photo_path ?? null,
      row.alias_avatar ?? null,
      'Teaches polity',
      'राजनीति पढ़ाते हैं',
      row.status,
    ],
  );
}

/** Read one teacher's stored row as the owner, bypassing RLS. */
async function storedTeacher(id: string): Promise<TeacherRow> {
  const r = await db.admin.query<TeacherRow>('select * from public.teachers where user_id = $1', [
    id,
  ]);
  return r.rows[0];
}

beforeAll(async () => {
  db = await createTestDb();

  aliasTeacher = await db.createUser();
  publicTeacher = await db.createUser();
  pendingTeacher = await db.createUser();
  student = await db.createUser();
  admin = await db.createUser();

  await makeAdmin(admin);

  await seedTeacher(aliasTeacher, {
    identity_mode: 'alias',
    status: 'approved',
    real_name: ALIAS_REAL_NAME,
    alias: ALIAS_NAME,
    photo_path: 'teachers/rahul.jpg',
    alias_avatar: 'avatars/owl.png',
  });

  await seedTeacher(publicTeacher, {
    identity_mode: 'public',
    status: 'approved',
    real_name: PUBLIC_REAL_NAME,
    alias: 'Hidden',
    photo_path: 'teachers/meera.jpg',
    alias_avatar: 'avatars/cat.png',
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

describe('migration', () => {
  it('applies 0005_teachers.sql', () => {
    expect(db.migrations).toContain('0005_teachers.sql');
  });
});

describe('privacy: a student never reads a real name (v0 alias rule)', () => {
  it('returns 0 rows from public.teachers for a student', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const r = await sql.query<TeacherRow>('select * from public.teachers');
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('returns no real_name even when the student asks for that column by name', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const r = await sql.query<{ real_name: string | null }>(
        'select real_name from public.teachers where user_id = $1',
        [aliasTeacher],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('keeps real_name and photo_path out of the teachers_public view entirely', async () => {
    const r = await db.admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'teachers_public'`,
    );
    const columns = r.rows.map((row) => row.column_name);
    expect(columns).not.toContain('real_name');
    expect(columns).not.toContain('photo_path');
    expect(columns).not.toContain('approved_by');
    expect(columns).not.toContain('revenue_share_pct');
    expect(columns).toContain('display_name');
  });

  it('shows a student the alias and the alias avatar, never the real ones', async () => {
    const row = await db.asUser(student, async (sql) => {
      const r = await sql.query<PublicRow>(
        'select * from public.teachers_public where user_id = $1',
        [aliasTeacher],
      );
      return r.rows[0];
    });

    expect(row.display_name).toBe(ALIAS_NAME);
    expect(row.avatar_path).toBe('avatars/owl.png');
    expect(JSON.stringify(row)).not.toContain(ALIAS_REAL_NAME);
    expect(JSON.stringify(row)).not.toContain('teachers/rahul.jpg');
  });

  it('shows the real name only for a teacher who chose public mode', async () => {
    const row = await db.asUser(student, async (sql) => {
      const r = await sql.query<PublicRow>(
        'select * from public.teachers_public where user_id = $1',
        [publicTeacher],
      );
      return r.rows[0];
    });
    expect(row.display_name).toBe(PUBLIC_REAL_NAME);
    expect(row.avatar_path).toBe('teachers/meera.jpg');
  });

  it('hides a teacher who is not approved yet from the view', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const r = await sql.query<PublicRow>('select * from public.teachers_public');
      return r.rows;
    });
    expect(rows.map((row) => row.user_id)).not.toContain(pendingTeacher);
    expect(rows).toHaveLength(2);
  });

  it('refuses a select of real_name through the view', async () => {
    await expect(
      db.asUser(student, (sql) => sql.query('select real_name from public.teachers_public')),
    ).rejects.toThrow();
  });

  it('refuses a write through the view, so the view is read-only for a student', async () => {
    await expect(
      db.asUser(student, (sql) =>
        sql.query("update public.teachers_public set bio_en = 'hacked'"),
      ),
    ).rejects.toThrow();
  });

  it('still lets the teacher read their own full row', async () => {
    const row = await db.asUser(aliasTeacher, async (sql) => {
      const r = await sql.query<TeacherRow>('select * from public.teachers');
      return r.rows;
    });
    expect(row).toHaveLength(1);
    expect(row[0].real_name).toBe(ALIAS_REAL_NAME);
  });
});

describe('V19: revenue share and status are admin-only', () => {
  it('stops a teacher from changing their own revenue_share_pct', async () => {
    await expect(
      db.asUser(aliasTeacher, (sql) =>
        sql.query('update public.teachers set revenue_share_pct = 90 where user_id = $1', [
          aliasTeacher,
        ]),
      ),
    ).rejects.toThrow(/admin/i);

    expect((await storedTeacher(aliasTeacher)).revenue_share_pct).toBe(50);
  });

  it('stops a teacher from approving themselves', async () => {
    await expect(
      db.asUser(pendingTeacher, (sql) =>
        sql.query("update public.teachers set status = 'approved' where user_id = $1", [
          pendingTeacher,
        ]),
      ),
    ).rejects.toThrow(/admin/i);

    expect((await storedTeacher(pendingTeacher)).status).toBe('pending');
  });

  it('defaults revenue_share_pct to 50 and videos_visible to true', async () => {
    const row = await storedTeacher(aliasTeacher);
    expect(row.revenue_share_pct).toBe(50);
    expect(row.videos_visible).toBe(true);
  });

  it('lets the teacher edit their own alias, bio and identity mode', async () => {
    await db.asUser(publicTeacher, (sql) =>
      sql.query(
        "update public.teachers set alias = 'Meera M', bio_en = 'New bio', identity_mode = 'alias' where user_id = $1",
        [publicTeacher],
      ),
    );
    const row = await storedTeacher(publicTeacher);
    expect(row.alias).toBe('Meera M');
    expect(row.identity_mode).toBe('alias');

    // Put it back: the privacy tests above read this row.
    await db.admin.query(
      "update public.teachers set identity_mode = 'public', alias = 'Hidden' where user_id = $1",
      [publicTeacher],
    );
  });

  it('stops a teacher from editing another teacher row (0 rows changed)', async () => {
    const changed = await db.asUser(aliasTeacher, async (sql) => {
      const r = await sql.query("update public.teachers set bio_en = 'nope' where user_id = $1", [
        publicTeacher,
      ]);
      return r.affectedRows ?? 0;
    });
    expect(changed).toBe(0);
  });
});

describe('admin approval', () => {
  it('sets status approved and records who approved it', async () => {
    await db.asUser(admin, (sql) =>
      sql.query(
        "update public.teachers set status = 'approved', approved_by = $2 where user_id = $1",
        [pendingTeacher, admin],
      ),
    );

    const row = await storedTeacher(pendingTeacher);
    expect(row.status).toBe('approved');
    expect(row.approved_by).toBe(admin);

    // Back to pending: the view test above counts approved teachers.
    await db.admin.query(
      "update public.teachers set status = 'pending', approved_by = null where user_id = $1",
      [pendingTeacher],
    );
  });

  it('lets an admin set the revenue share (V19)', async () => {
    await db.asUser(admin, (sql) =>
      sql.query('update public.teachers set revenue_share_pct = 60 where user_id = $1', [
        aliasTeacher,
      ]),
    );
    expect((await storedTeacher(aliasTeacher)).revenue_share_pct).toBe(60);

    await db.admin.query('update public.teachers set revenue_share_pct = 50 where user_id = $1', [
      aliasTeacher,
    ]);
  });

  it('lets an admin read the pending list, real names included', async () => {
    const rows = await db.asUser(admin, async (sql) => {
      const r = await sql.query<TeacherRow>(
        "select * from public.teachers where status = 'pending'",
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(pendingTeacher);
    expect(rows[0].real_name).toBe('Not Approved Yet');
  });

  it('rejects a revenue share outside 0..100', async () => {
    await expect(
      db.admin.query('update public.teachers set revenue_share_pct = 140 where user_id = $1', [
        aliasTeacher,
      ]),
    ).rejects.toThrow();
  });
});

describe('invite codes', () => {
  /** Redeem a code as `user`, through the function a route handler calls. */
  function redeem(user: string, code: string) {
    return db.asUser(user, (sql) => sql.query('select public.redeem_teacher_invite($1)', [code]));
  }

  it('turns a signed-in user into a pending teacher', async () => {
    const code = 'INVITE-ONE';
    const newcomer = await db.createUser();
    await db.admin.query('insert into public.teacher_invites (code, created_by) values ($1, $2)', [
      code,
      admin,
    ]);

    await redeem(newcomer, code);

    const row = await storedTeacher(newcomer);
    expect(row.status).toBe('pending');
    expect(row.identity_mode).toBe('alias');
    expect(row.revenue_share_pct).toBe(50);

    const profile = await db.admin.query<{ role: string }>(
      'select role from public.profiles where id = $1',
      [newcomer],
    );
    expect(profile.rows[0].role).toBe('teacher');

    const invite = await db.admin.query<{ used_by: string | null; used_at: string | null }>(
      'select used_by, used_at from public.teacher_invites where code = $1',
      [code],
    );
    expect(invite.rows[0].used_by).toBe(newcomer);
    expect(invite.rows[0].used_at).not.toBeNull();
  });

  it('cannot use the same code twice', async () => {
    const code = 'INVITE-TWO';
    const first = await db.createUser();
    const second = await db.createUser();
    await db.admin.query('insert into public.teacher_invites (code, created_by) values ($1, $2)', [
      code,
      admin,
    ]);

    await redeem(first, code);
    await expect(redeem(second, code)).rejects.toThrow();

    // The second user got nothing: no teacher row, still a student.
    const rows = await db.admin.query('select 1 from public.teachers where user_id = $1', [second]);
    expect(rows.rows).toHaveLength(0);
    const profile = await db.admin.query<{ role: string }>(
      'select role from public.profiles where id = $1',
      [second],
    );
    expect(profile.rows[0].role).toBe('student');

    // And the first user still owns the code.
    const invite = await db.admin.query<{ used_by: string | null }>(
      'select used_by from public.teacher_invites where code = $1',
      [code],
    );
    expect(invite.rows[0].used_by).toBe(first);
  });

  it('refuses a code that does not exist', async () => {
    const nobody = await db.createUser();
    await expect(redeem(nobody, 'NO-SUCH-CODE')).rejects.toThrow();
    const rows = await db.admin.query('select 1 from public.teachers where user_id = $1', [nobody]);
    expect(rows.rows).toHaveLength(0);
  });

  it('hides the invite codes from a student, so they cannot be guessed', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const r = await sql.query('select * from public.teacher_invites');
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('lets an admin create and read invite codes', async () => {
    const code = 'INVITE-ADMIN';
    await db.asUser(admin, (sql) =>
      sql.query('insert into public.teacher_invites (code, created_by) values ($1, $2)', [
        code,
        admin,
      ]),
    );
    const rows = await db.asUser(admin, async (sql) => {
      const r = await sql.query<{ code: string }>(
        'select code from public.teacher_invites where code = $1',
        [code],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses to redeem a second code once you are already a teacher', async () => {
    const code = 'INVITE-THREE';
    await db.admin.query('insert into public.teacher_invites (code, created_by) values ($1, $2)', [
      code,
      admin,
    ]);
    await expect(redeem(aliasTeacher, code)).rejects.toThrow();
    const invite = await db.admin.query<{ used_by: string | null }>(
      'select used_by from public.teacher_invites where code = $1',
      [code],
    );
    expect(invite.rows[0].used_by).toBeNull();
  });
});
