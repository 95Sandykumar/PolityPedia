/**
 * Per-teacher next exam date (issue 07-next-exam-date-teacher-shell).
 *
 * Design constraint V7: each teacher keeps the next exam date per exam, so the
 * row owner is the TEACHER, not the platform. The proofs the issue asks for:
 *
 *  1. a teacher writes their OWN rows (insert, update, delete).
 *  2. teacher A cannot edit, add or delete teacher B's dates.
 *  3. a signed-in student READS an approved teacher's dates (the pill).
 *  4. a teacher who is not approved yet is invisible, like everywhere else.
 *  5. anon reads nothing and writes nothing.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the rows in most tests below. */
let teacherA: string;
/** A second approved teacher. The attacker in the privacy tests. */
let teacherB: string;
/** Redeemed an invite, still waiting for an admin. */
let pendingTeacher: string;
/** A plain student. Reads the pill, writes nothing. */
let student: string;

/** Two exams from the 0004 seed, by their fixed ids. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  teacherB = await db.createUser();
  pendingTeacher = await db.createUser();
  student = await db.createUser();

  const rows = [
    [teacherA, 'Polity Guru', 'approved'],
    [teacherB, 'Other Guru', 'approved'],
    [pendingTeacher, 'Newcomer', 'pending'],
  ] as const;

  for (const [id, alias, status] of rows) {
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', $2, $3)`,
      [id, alias, status],
    );
  }
});

afterAll(async () => {
  await db?.close();
});

/** Reads with the owner handle, so RLS never hides a row the test is asserting. */
async function storedDate(teacherId: string, examId: string): Promise<string | null> {
  const res = await db.admin.query<{ d: string | null }>(
    `select to_char(next_exam_date, 'YYYY-MM-DD') as d
       from public.teacher_exams
      where teacher_id = $1 and exam_id = $2`,
    [teacherId, examId],
  );
  return res.rows.length === 0 ? null : res.rows[0].d;
}

describe('0007_teacher_exams.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0007_teacher_exams.sql');
  });

  it('has row level security on', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.teacher_exams'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('keys a row on (teacher_id, exam_id), so one exam has one date', async () => {
    await db.asUser(teacherA, async (sql) => {
      await sql.query(
        `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date, label)
         values ($1, $2, '2026-12-18', 'NET')`,
        [teacherA, NET],
      );
    });

    await expect(
      db.asUser(teacherA, async (sql) => {
        await sql.query(
          `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
           values ($1, $2, '2027-01-01')`,
          [teacherA, NET],
        );
      }),
    ).rejects.toThrow();

    expect(await storedDate(teacherA, NET)).toBe('2026-12-18');
    await db.admin.query('delete from public.teacher_exams');
  });

  it('refuses a teacher_id that is not a teacher at all', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
           values ($1, $2, '2026-12-18')`,
          [student, NET],
        );
      }),
    ).rejects.toThrow();
  });
});

describe('own rows', () => {
  it('inserts, updates and deletes the teacher own dates', async () => {
    await db.asUser(teacherA, async (sql) => {
      await sql.query(
        `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date, label)
         values ($1, $2, '2026-12-18', 'NET')`,
        [teacherA, NET],
      );
    });
    expect(await storedDate(teacherA, NET)).toBe('2026-12-18');

    await db.asUser(teacherA, async (sql) => {
      await sql.query(
        `update public.teacher_exams set next_exam_date = '2027-03-09'
          where teacher_id = $1 and exam_id = $2`,
        [teacherA, NET],
      );
    });
    expect(await storedDate(teacherA, NET)).toBe('2027-03-09');

    const mine = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query('select exam_id from public.teacher_exams');
      return res.rows;
    });
    expect(mine).toHaveLength(1);

    await db.asUser(teacherA, async (sql) => {
      await sql.query('delete from public.teacher_exams where exam_id = $1', [NET]);
    });
    expect(await storedDate(teacherA, NET)).toBeNull();
  });

  it('allows a row with no date yet, so an exam can be listed before the notice', async () => {
    await db.asUser(teacherA, async (sql) => {
      await sql.query('insert into public.teacher_exams (teacher_id, exam_id) values ($1, $2)', [
        teacherA,
        CUET,
      ]);
    });
    expect(await storedDate(teacherA, CUET)).toBeNull();

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.teacher_exams where teacher_id = $1',
      [teacherA],
    );
    expect(res.rows[0].n).toBe(1);
    await db.admin.query('delete from public.teacher_exams');
  });
});

describe('another teacher', () => {
  beforeAll(async () => {
    await db.admin.query(
      `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date, label)
       values ($1, $2, '2026-12-18', 'NET')`,
      [teacherB, NET],
    );
  });

  it('refuses an insert that names a different teacher_id', async () => {
    await expect(
      db.asUser(teacherA, async (sql) => {
        await sql.query(
          `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
           values ($1, $2, '2026-12-18')`,
          [teacherB, CUET],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await storedDate(teacherB, CUET)).toBeNull();
  });

  it('cannot edit teacher B dates', async () => {
    await db.asUser(teacherA, async (sql) => {
      await sql.query(
        `update public.teacher_exams set next_exam_date = '2030-01-01'
          where teacher_id = $1 and exam_id = $2`,
        [teacherB, NET],
      );
    });
    expect(await storedDate(teacherB, NET)).toBe('2026-12-18');
  });

  it('cannot move a row to itself by changing teacher_id', async () => {
    await db.asUser(teacherA, async (sql) => {
      await sql.query('update public.teacher_exams set teacher_id = $1', [teacherA]);
    });
    expect(await storedDate(teacherB, NET)).toBe('2026-12-18');
    expect(await storedDate(teacherA, NET)).toBeNull();
  });

  it('cannot delete teacher B dates', async () => {
    await db.asUser(teacherA, async (sql) => {
      await sql.query('delete from public.teacher_exams');
    });
    expect(await storedDate(teacherB, NET)).toBe('2026-12-18');
  });
});

describe('a student reading the pill', () => {
  it('reads an approved teacher dates', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ teacher_id: string; label: string | null }>(
        'select teacher_id, label from public.teacher_exams where teacher_id = $1',
        [teacherB],
      );
      return res.rows;
    });
    expect(rows).toEqual([{ teacher_id: teacherB, label: 'NET' }]);
  });

  it('cannot write or drop a date for a teacher', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
           values ($1, $2, '2026-12-18')`,
          [teacherB, CUET],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    await db.asUser(student, async (sql) => {
      await sql.query('delete from public.teacher_exams');
    });
    expect(await storedDate(teacherB, NET)).toBe('2026-12-18');
  });

  it('does not see a teacher who is still waiting for approval', async () => {
    await db.admin.query(
      `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
       values ($1, $2, '2026-12-18')`,
      [pendingTeacher, NET],
    );

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query('select * from public.teacher_exams where teacher_id = $1', [
        pendingTeacher,
      ]);
      return res.rows;
    });
    expect(seen).toEqual([]);

    // The pending teacher still reads their own row: it is theirs.
    const own = await db.asUser(pendingTeacher, async (sql) => {
      const res = await sql.query('select exam_id from public.teacher_exams where teacher_id = $1', [
        pendingTeacher,
      ]);
      return res.rows;
    });
    expect(own).toHaveLength(1);

    await db.admin.query('delete from public.teacher_exams where teacher_id = $1', [
      pendingTeacher,
    ]);
  });

  it('drops the dates when the teacher account is deleted', async () => {
    const extra = await db.createUser();
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', 'Leaving', 'approved')`,
      [extra],
    );
    await db.asUser(extra, async (sql) => {
      await sql.query(
        `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
         values ($1, $2, '2026-12-18')`,
        [extra, NET],
      );
    });
    expect(await storedDate(extra, NET)).toBe('2026-12-18');

    await db.admin.query('delete from auth.users where id = $1', [extra]);
    expect(await storedDate(extra, NET)).toBeNull();
  });
});

describe('anon', () => {
  it('sees nothing and cannot insert', async () => {
    const seen = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.teacher_exams');
      return res.rows;
    });
    expect(seen).toEqual([]);

    await expect(
      db.asAnon(async (sql) => {
        await sql.query(
          `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date)
           values ($1, $2, '2026-12-18')`,
          [teacherB, CUET],
        );
      }),
    ).rejects.toThrow();
  });
});
