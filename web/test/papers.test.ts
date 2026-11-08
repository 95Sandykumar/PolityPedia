/**
 * Past papers: teacher upload and student browse (issue 10-papers-upload-browse).
 *
 * Design constraint V8: past papers are PER TEACHER and free for students.
 * Each teacher keeps their own copy, so the row owner is the TEACHER and only
 * that teacher may edit it (PRD F-D1).
 *
 * The proofs the issue asks for, at the database level:
 *
 *  1. a student sees only LIVE papers.
 *  2. teacher B cannot read (or touch) teacher A's DRAFTS.
 *  3. a teacher writes, edits and drops their own rows.
 *  4. UNIQUE (teacher_id, exam_id, year, month, label) holds, with NO month
 *     as well: two "no month" rows with the same label are the same paper.
 *  5. anon sees nothing and writes nothing.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the papers in most tests below. */
let teacherA: string;
/** A second approved teacher. The attacker in the privacy tests. */
let teacherB: string;
/** Redeemed an invite, still waiting for an admin. */
let pendingTeacher: string;
/** A plain student. Browses live papers, writes nothing. */
let student: string;

/** Two exams from the 0004 seed, by their fixed ids. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

interface PaperRow {
  id: string;
  label: string;
  status: string;
  year: number;
  month: number | null;
}

async function insertPaper(
  teacherId: string,
  values: {
    examId?: string;
    year?: number;
    month?: number | null;
    label?: string;
    status?: string;
    questionsPath?: string | null;
    solutionsPath?: string | null;
  } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, month, label, status,
        pdf_questions_path, pdf_solutions_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      teacherId,
      values.examId ?? NET,
      values.year ?? 2024,
      values.month ?? null,
      values.label ?? 'Paper 1',
      values.status ?? 'live',
      values.questionsPath === undefined ? 'papers/q.pdf' : values.questionsPath,
      values.solutionsPath ?? null,
    ],
  );
  return res.rows[0].id;
}

/** Reads with the owner handle, so RLS never hides a row the test asserts on. */
async function stored(paperId: string): Promise<PaperRow | null> {
  const res = await db.admin.query<PaperRow>(
    'select id, label, status, year, month from public.papers where id = $1',
    [paperId],
  );
  return res.rows[0] ?? null;
}

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

describe('0010_papers.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0010_papers.sql');
  });

  it('has row level security on', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.papers'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('starts a paper as a draft, because publish is a separate step', async () => {
    const res = await db.admin.query<{ status: string }>(
      `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path)
       values ($1, $2, 2023, 'Default status', 'papers/q.pdf')
       returning status`,
      [teacherA, NET],
    );
    expect(res.rows[0].status).toBe('draft');
    await db.admin.query('delete from public.papers');
  });

  it('refuses a status that is neither draft nor live', async () => {
    await expect(insertPaper(teacherA, { status: 'published' })).rejects.toThrow();
  });

  it('refuses a paper with no PDF at all', async () => {
    await expect(
      insertPaper(teacherA, { questionsPath: null, solutionsPath: null }),
    ).rejects.toThrow();
  });

  it('refuses a month outside 1 to 12', async () => {
    await expect(insertPaper(teacherA, { month: 13 })).rejects.toThrow();
    await expect(insertPaper(teacherA, { month: 0 })).rejects.toThrow();
  });

  it('refuses a blank label', async () => {
    await expect(insertPaper(teacherA, { label: '   ' })).rejects.toThrow();
  });
});

describe('UNIQUE (teacher_id, exam_id, year, month, label)', () => {
  it('refuses the same paper twice for one teacher', async () => {
    const id = await insertPaper(teacherA, { year: 2024, month: 6, label: 'Shift 1' });
    await expect(
      insertPaper(teacherA, { year: 2024, month: 6, label: 'Shift 1' }),
    ).rejects.toThrow();
    await db.admin.query('delete from public.papers where id = $1', [id]);
  });

  it('refuses it with NO month as well, so NULL is not a loophole', async () => {
    const id = await insertPaper(teacherA, { year: 2024, month: null, label: 'Full paper' });
    await expect(
      insertPaper(teacherA, { year: 2024, month: null, label: 'Full paper' }),
    ).rejects.toThrow();
    await db.admin.query('delete from public.papers where id = $1', [id]);
  });

  it('lets two teachers keep their own copy of the same paper', async () => {
    const a = await insertPaper(teacherA, { year: 2024, month: 6, label: 'Shift 1' });
    const b = await insertPaper(teacherB, { year: 2024, month: 6, label: 'Shift 1' });
    expect(a).not.toBe(b);
    await db.admin.query('delete from public.papers');
  });
});

describe('a teacher and their own papers', () => {
  it('inserts, edits and drops them', async () => {
    const id = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into public.papers
           (teacher_id, exam_id, year, month, label, pdf_questions_path)
         values ($1, $2, 2024, 6, 'Shift 1', 'papers/a/q.pdf')
         returning id`,
        [teacherA, NET],
      );
      return res.rows[0].id;
    });
    expect((await stored(id))?.status).toBe('draft');

    await db.asUser(teacherA, async (sql) => {
      await sql.query(`update public.papers set label = 'Shift 2' where id = $1`, [id]);
    });
    expect((await stored(id))?.label).toBe('Shift 2');

    // 0041: the DELETE policy is gone; remove_paper() hard-deletes a paper
    // nobody has sat and archives one that has attempts.
    const result = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ r: string }>('select public.remove_paper($1) as r', [id]);
      return res.rows[0].r;
    });
    expect(result).toBe('deleted');
    expect(await stored(id)).toBeNull();
  });

  it('reads its own drafts', async () => {
    const draft = await insertPaper(teacherA, { status: 'draft', label: 'My draft' });

    const mine = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ label: string }>('select label from public.papers');
      return res.rows;
    });
    expect(mine).toEqual([{ label: 'My draft' }]);

    await db.admin.query('delete from public.papers where id = $1', [draft]);
  });

  it('refuses a teacher_id that is not a teacher at all', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path)
           values ($1, $2, 2024, 'Fake', 'papers/x.pdf')`,
          [student, NET],
        );
      }),
    ).rejects.toThrow();
  });
});

describe('another teacher', () => {
  let draftOfA: string;
  let liveOfA: string;

  beforeAll(async () => {
    await db.admin.query('delete from public.papers');
    draftOfA = await insertPaper(teacherA, { status: 'draft', label: 'A draft' });
    liveOfA = await insertPaper(teacherA, { status: 'live', label: 'A live' });
  });

  it('cannot read teacher A drafts', async () => {
    const seen = await db.asUser(teacherB, async (sql) => {
      const res = await sql.query<{ label: string }>(
        'select label from public.papers where teacher_id = $1 order by label',
        [teacherA],
      );
      return res.rows;
    });
    // The live one is public, the draft is not there at all.
    expect(seen).toEqual([{ label: 'A live' }]);
  });

  it('cannot edit or delete teacher A papers', async () => {
    await db.asUser(teacherB, async (sql) => {
      await sql.query(`update public.papers set label = 'stolen'`);
      await sql.query('delete from public.papers');
    });

    expect((await stored(draftOfA))?.label).toBe('A draft');
    expect((await stored(liveOfA))?.label).toBe('A live');
  });

  it('cannot move a paper to itself by changing teacher_id', async () => {
    await db.asUser(teacherB, async (sql) => {
      await sql.query('update public.papers set teacher_id = $1', [teacherB]);
    });

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.papers where teacher_id = $1',
      [teacherB],
    );
    expect(res.rows[0].n).toBe(0);
  });

  it('cannot insert a paper that names a different teacher', async () => {
    await expect(
      db.asUser(teacherB, async (sql) => {
        await sql.query(
          `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path)
           values ($1, $2, 2025, 'Planted', 'papers/x.pdf')`,
          [teacherA, CUET],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('a student browsing papers', () => {
  beforeAll(async () => {
    await db.admin.query('delete from public.papers');
    await insertPaper(teacherA, { status: 'live', label: 'Live 2024', year: 2024, month: 6 });
    await insertPaper(teacherA, { status: 'draft', label: 'Draft 2025', year: 2025 });
    await insertPaper(teacherA, { status: 'live', label: 'Live 2023', year: 2023, examId: CUET });
  });

  it('sees only live papers', async () => {
    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ label: string; status: string }>(
        'select label, status from public.papers order by label',
      );
      return res.rows;
    });

    expect(seen).toEqual([
      { label: 'Live 2023', status: 'live' },
      { label: 'Live 2024', status: 'live' },
    ]);
  });

  it('cannot write, edit or drop a paper', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path)
           values ($1, $2, 2024, 'Student made', 'papers/x.pdf')`,
          [teacherA, NET],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    await db.asUser(student, async (sql) => {
      await sql.query(`update public.papers set status = 'draft'`);
      await sql.query('delete from public.papers');
    });

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.papers',
    );
    expect(res.rows[0].n).toBe(3);
  });

  it('does not see the live papers of a teacher who is still waiting for approval', async () => {
    const hidden = await insertPaper(pendingTeacher, { status: 'live', label: 'Too early' });

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query('select id from public.papers where teacher_id = $1', [
        pendingTeacher,
      ]);
      return res.rows;
    });
    expect(seen).toEqual([]);

    // The pending teacher still reads their own paper: it is theirs. They also
    // read the live papers of approved teachers, like any signed-in user, so
    // the filter here is what makes the assertion about their own row.
    const own = await db.asUser(pendingTeacher, async (sql) => {
      const res = await sql.query('select id from public.papers where teacher_id = $1', [
        pendingTeacher,
      ]);
      return res.rows;
    });
    expect(own).toHaveLength(1);

    await db.admin.query('delete from public.papers where id = $1', [hidden]);
  });

  it('loses the papers when the teacher account is deleted', async () => {
    const extra = await db.createUser();
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', 'Leaving', 'approved')`,
      [extra],
    );
    const id = await insertPaper(extra, { label: 'Goes with them' });
    expect(await stored(id)).not.toBeNull();

    await db.admin.query('delete from auth.users where id = $1', [extra]);
    expect(await stored(id)).toBeNull();
  });
});

describe('anon', () => {
  it('sees nothing and cannot insert', async () => {
    const seen = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.papers');
      return res.rows;
    });
    expect(seen).toEqual([]);

    await expect(
      db.asAnon(async (sql) => {
        await sql.query(
          `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path)
           values ($1, $2, 2024, 'Anon', 'papers/x.pdf')`,
          [teacherA, NET],
        );
      }),
    ).rejects.toThrow();
  });
});
