/**
 * Follow and unfollow a teacher (issue 06-portfolio-follow).
 *
 * `follows` is the smallest table in the app and the rule is the strictest:
 * a row belongs to exactly one student, so every policy is `auth.uid() =
 * user_id`. The proofs the issue asks for:
 *
 *  1. follow, then unfollow, works for the caller's OWN rows.
 *  2. a student cannot insert a follow for another user.
 *  3. a student cannot read, or delete, another student's follows.
 *  4. a follow of a teacher who is not approved yet is refused.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. The one a student is allowed to follow. */
let teacher: string;
/** Redeemed an invite, still waiting for an admin. Must not be followable. */
let pendingTeacher: string;
/** The student in every test below. */
let student: string;
/** A second student. The attacker in the privacy tests. */
let other: string;

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  pendingTeacher = await db.createUser();
  student = await db.createUser();
  other = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacher],
  );
  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Newcomer', 'pending')`,
    [pendingTeacher],
  );
});

afterAll(async () => {
  await db?.close();
});

async function countFollows(userId: string, teacherId: string): Promise<number> {
  const res = await db.admin.query<{ n: number }>(
    'select count(*)::int as n from public.follows where user_id = $1 and teacher_id = $2',
    [userId, teacherId],
  );
  return res.rows[0].n;
}

describe('0006_follows.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0006_follows.sql');
  });

  it('has row level security on', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.follows'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('keys a row on both columns, so the same follow cannot exist twice', async () => {
    await db.asUser(student, async (sql) => {
      await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
        student,
        teacher,
      ]);
    });

    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
          student,
          teacher,
        ]);
      }),
    ).rejects.toThrow();

    expect(await countFollows(student, teacher)).toBe(1);

    // Leave the table clean for the tests below.
    await db.admin.query('delete from public.follows');
  });
});

describe('own rows', () => {
  it('follows then unfollows, and reads the row back in between', async () => {
    const followed = await db.asUser(student, async (sql) => {
      await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
        student,
        teacher,
      ]);
      const res = await sql.query<{ teacher_id: string }>(
        'select teacher_id from public.follows',
      );
      return res.rows.map((r) => r.teacher_id);
    });
    expect(followed).toEqual([teacher]);
    expect(await countFollows(student, teacher)).toBe(1);

    const left = await db.asUser(student, async (sql) => {
      await sql.query('delete from public.follows where teacher_id = $1', [teacher]);
      const res = await sql.query('select teacher_id from public.follows');
      return res.rows;
    });
    expect(left).toEqual([]);
    expect(await countFollows(student, teacher)).toBe(0);
  });
});

describe('another user', () => {
  it('refuses an insert that names a different user_id', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
          other,
          teacher,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await countFollows(other, teacher)).toBe(0);
  });

  it('hides another student\'s follows and cannot delete them', async () => {
    await db.admin.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
      other,
      teacher,
    ]);

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query('select * from public.follows');
      return res.rows;
    });
    expect(seen).toEqual([]);

    await db.asUser(student, async (sql) => {
      await sql.query('delete from public.follows where teacher_id = $1', [teacher]);
    });
    expect(await countFollows(other, teacher)).toBe(1);

    await db.admin.query('delete from public.follows');
  });
});

describe('who may be followed', () => {
  it('refuses a teacher who is still waiting for approval', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
          student,
          pendingTeacher,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await countFollows(student, pendingTeacher)).toBe(0);
  });

  it('refuses a user who is not a teacher at all', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
          student,
          other,
        ]);
      }),
    ).rejects.toThrow();

    expect(await countFollows(student, other)).toBe(0);
  });

  it('drops the follows when the teacher account is deleted', async () => {
    const extra = await db.createUser();
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', 'Leaving', 'approved')`,
      [extra],
    );
    await db.asUser(student, async (sql) => {
      await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
        student,
        extra,
      ]);
    });
    expect(await countFollows(student, extra)).toBe(1);

    await db.admin.query('delete from auth.users where id = $1', [extra]);
    expect(await countFollows(student, extra)).toBe(0);
  });
});

describe('anon', () => {
  it('sees nothing and cannot insert', async () => {
    await db.admin.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
      student,
      teacher,
    ]);

    const seen = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.follows');
      return res.rows;
    });
    expect(seen).toEqual([]);

    await expect(
      db.asAnon(async (sql) => {
        await sql.query('insert into public.follows (user_id, teacher_id) values ($1, $2)', [
          student,
          teacher,
        ]);
      }),
    ).rejects.toThrow();

    await db.admin.query('delete from public.follows');
  });
});
