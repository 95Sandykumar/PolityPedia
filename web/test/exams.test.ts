/**
 * Exam catalogue + the student's chosen exams (issue 04-exams-onboarding).
 *
 * Proves the two rules the issue asks for:
 * - `exams` is shared reference data: every signed-in user reads it, a visitor
 *   who is not signed in reads nothing, and nobody writes it through the API.
 * - `student_exams` is private: a student reads and writes only their own rows.
 *
 * RLS is enforced by Postgres (see test/db.ts), never faked in JS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

type ExamRow = {
  id: string;
  code: string;
  name_en: string;
  name_hi: string;
  marks_correct: string | null;
  marks_wrong: string | null;
  duration_min: number | null;
  question_count: number | null;
  marking_unverified: boolean;
};

let db: TestDb;
let userA: string;
let userB: string;
let examIds: Record<string, string>;

beforeAll(async () => {
  db = await createTestDb();
  userA = await db.createUser();
  userB = await db.createUser();
  const r = await db.admin.query<ExamRow>('select * from public.exams');
  examIds = Object.fromEntries(r.rows.map((row) => [row.code, row.id]));
});

afterAll(async () => {
  await db?.close();
});

describe('exams seed', () => {
  it('ships the four v1 exams', async () => {
    const r = await db.admin.query<{ code: string }>('select code from public.exams order by code');
    expect(r.rows.map((row) => row.code)).toEqual([
      'cuet_pg_pol_sci_huqp18',
      'pgt_pol_sci',
      'tgt_social_science',
      'ugc_net_pol_sci',
    ]);
  });

  it('gives every exam an English and a Hindi name', async () => {
    const r = await db.admin.query<ExamRow>('select * from public.exams');
    for (const row of r.rows) {
      expect(row.name_en.length).toBeGreaterThan(0);
      expect(row.name_hi.length).toBeGreaterThan(0);
      expect(row.name_hi).not.toBe(row.name_en);
    }
  });

  it('stores CUET PG as +4 / -1, 90 minutes, 75 questions (PRD F-E6)', async () => {
    const r = await db.admin.query<ExamRow>('select * from public.exams where code = $1', [
      'cuet_pg_pol_sci_huqp18',
    ]);
    const row = r.rows[0];
    expect(Number(row.marks_correct)).toBe(4);
    expect(Number(row.marks_wrong)).toBe(-1);
    expect(row.duration_min).toBe(90);
    expect(row.question_count).toBe(75);
    expect(row.marking_unverified).toBe(false);
  });

  it('stores UGC NET as +2 / 0 and flags it unverified (PRD AS5)', async () => {
    const r = await db.admin.query<ExamRow>('select * from public.exams where code = $1', [
      'ugc_net_pol_sci',
    ]);
    const row = r.rows[0];
    expect(Number(row.marks_correct)).toBe(2);
    expect(Number(row.marks_wrong)).toBe(0);
    expect(row.marking_unverified).toBe(true);
  });

  it('leaves PGT and TGT marking null until it is known', async () => {
    const r = await db.admin.query<ExamRow>(
      'select * from public.exams where code in ($1, $2) order by code',
      ['pgt_pol_sci', 'tgt_social_science'],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.marks_correct).toBeNull();
      expect(row.marks_wrong).toBeNull();
      expect(row.duration_min).toBeNull();
      expect(row.question_count).toBeNull();
    }
  });
});

describe('exams RLS', () => {
  it('lets any signed-in user read every exam', async () => {
    const rows = await db.asUser(userA, async (sql) => {
      const r = await sql.query<ExamRow>('select * from public.exams');
      return r.rows;
    });
    expect(rows).toHaveLength(4);
  });

  it('shows no exam to a visitor who is not signed in', async () => {
    const rows = await db.asAnon(async (sql) => {
      const r = await sql.query<ExamRow>('select * from public.exams');
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('stops a signed-in user from adding an exam (0 rows written)', async () => {
    await expect(
      db.asUser(userA, async (sql) => {
        await sql.query(
          'insert into public.exams (code, name_en, name_hi) values ($1, $2, $3)',
          ['fake_exam', 'Fake', 'नकली'],
        );
      }),
    ).rejects.toThrow();
    const r = await db.admin.query('select 1 from public.exams where code = $1', ['fake_exam']);
    expect(r.rows).toHaveLength(0);
  });
});

describe('student_exams RLS', () => {
  it('lets a student pick exams and read back only their own rows', async () => {
    await db.asUser(userA, async (sql) => {
      await sql.query('insert into public.student_exams (user_id, exam_id) values ($1, $2), ($1, $3)', [
        userA,
        examIds.ugc_net_pol_sci,
        examIds.cuet_pg_pol_sci_huqp18,
      ]);
    });
    await db.asUser(userB, async (sql) => {
      await sql.query('insert into public.student_exams (user_id, exam_id) values ($1, $2)', [
        userB,
        examIds.pgt_pol_sci,
      ]);
    });

    const mine = await db.asUser(userA, async (sql) => {
      const r = await sql.query<{ exam_id: string }>('select exam_id from public.student_exams');
      return r.rows.map((row) => row.exam_id);
    });
    expect(mine).toHaveLength(2);
    expect(new Set(mine)).toEqual(
      new Set([examIds.ugc_net_pol_sci, examIds.cuet_pg_pol_sci_huqp18]),
    );
    expect(mine).not.toContain(examIds.pgt_pol_sci);

    // The rows really are there for both users: the owner role bypasses RLS.
    const all = await db.admin.query('select 1 from public.student_exams');
    expect(all.rows).toHaveLength(3);
  });

  it("stops a student from picking an exam for somebody else", async () => {
    await expect(
      db.asUser(userA, async (sql) => {
        await sql.query('insert into public.student_exams (user_id, exam_id) values ($1, $2)', [
          userB,
          examIds.tgt_social_science,
        ]);
      }),
    ).rejects.toThrow();
    const r = await db.admin.query('select 1 from public.student_exams where user_id = $1', [userB]);
    expect(r.rows).toHaveLength(1);
  });

  it("stops a student from deleting somebody else's pick (0 rows deleted)", async () => {
    const deleted = await db.asUser(userA, async (sql) => {
      const r = await sql.query('delete from public.student_exams where user_id = $1', [userB]);
      return r.affectedRows ?? 0;
    });
    expect(deleted).toBe(0);
    const r = await db.admin.query('select 1 from public.student_exams where user_id = $1', [userB]);
    expect(r.rows).toHaveLength(1);
  });

  it('lets a student drop their own pick', async () => {
    const deleted = await db.asUser(userA, async (sql) => {
      const r = await sql.query('delete from public.student_exams where exam_id = $1', [
        examIds.cuet_pg_pol_sci_huqp18,
      ]);
      return r.affectedRows ?? 0;
    });
    expect(deleted).toBe(1);
    const r = await db.admin.query('select 1 from public.student_exams where user_id = $1', [userA]);
    expect(r.rows).toHaveLength(1);
  });

  it('keeps one row per (user, exam) pair', async () => {
    await expect(
      db.asUser(userA, async (sql) => {
        await sql.query('insert into public.student_exams (user_id, exam_id) values ($1, $2)', [
          userA,
          examIds.ugc_net_pol_sci,
        ]);
      }),
    ).rejects.toThrow(/duplicate key|student_exams_pkey/i);
  });
});
