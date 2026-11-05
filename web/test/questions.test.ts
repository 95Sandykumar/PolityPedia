/**
 * Split job, questions, teacher review and publish (issue 11-ingest-job-review-publish).
 *
 * Design constraint V9: "Nothing is live before teacher publish." Risk 1 in
 * design.md says the same thing the other way round: wrong answers from the AI
 * split must not reach students before a teacher has checked them.
 *
 * So this file proves the five things the issue asks for, in Postgres, where
 * the guarantee has to live:
 *
 *  1. `publish_paper()` is REFUSED while one question is still unchecked.
 *  2. a successful publish moves the paper AND every question in ONE
 *     transaction, and a refused one moves nothing.
 *  3. a student cannot read a DRAFT question at all.
 *  4. teacher B cannot read or edit teacher A's questions.
 *  5. `options` must be exactly 4.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the paper and the questions below. */
let teacherA: string;
/** A second approved teacher. The attacker in the privacy tests. */
let teacherB: string;
/** A plain student. Reads live questions, writes nothing. */
let student: string;

/** Teacher A's paper, and teacher B's own paper. Both drafts to begin with. */
let paperA: string;
let paperB: string;

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

interface QuestionRow {
  id: string;
  number: number;
  checked: boolean;
  status: string;
}

async function insertPaper(teacherId: string, label: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, $3, 'papers/q.pdf', 'draft')
     returning id`,
    [teacherId, NET, label],
  );
  return res.rows[0].id;
}

async function insertQuestion(
  teacherId: string,
  paperId: string | null,
  values: {
    number?: number;
    options?: string;
    correctIdx?: number;
    checked?: boolean;
    status?: string;
    testId?: string | null;
    lang?: string;
    stem?: string;
  } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        checked, status, lang)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     returning id`,
    [
      teacherId,
      paperId,
      values.testId ?? null,
      values.number ?? 1,
      values.stem ?? 'Which house is the Council of States?',
      values.options ?? OPTIONS,
      values.correctIdx ?? 1,
      values.checked ?? false,
      values.status ?? 'draft',
      values.lang ?? 'en',
    ],
  );
  return res.rows[0].id;
}

async function insertJob(
  teacherId: string,
  paperId: string,
  status = 'queued',
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.ingest_jobs (teacher_id, paper_id, pdf_path, status)
     values ($1, $2, 'papers/q.pdf', $3)
     returning id`,
    [teacherId, paperId, status],
  );
  return res.rows[0].id;
}

/** Reads with the owner handle, so RLS never hides a row the test asserts on. */
async function storedQuestions(paperId: string): Promise<QuestionRow[]> {
  const res = await db.admin.query<QuestionRow>(
    `select id, number, checked, status
     from public.questions where paper_id = $1 order by number`,
    [paperId],
  );
  return res.rows;
}

async function paperStatus(paperId: string): Promise<string | null> {
  const res = await db.admin.query<{ status: string }>(
    'select status from public.papers where id = $1',
    [paperId],
  );
  return res.rows[0]?.status ?? null;
}

/** Call `publish_paper()` as the given user, exactly the way the app does. */
function publishAs(userId: string, paperId: string): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ published: number }>(
      'select public.publish_paper($1) as published',
      [paperId],
    );
    return res.rows[0].published;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  teacherB = await db.createUser();
  student = await db.createUser();

  for (const [id, alias] of [
    [teacherA, 'Polity Guru'],
    [teacherB, 'Other Guru'],
  ] as const) {
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', $2, 'approved')`,
      [id, alias],
    );
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Questions and jobs first: both point at the papers.
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.ingest_jobs');
  await db.admin.query('delete from public.papers');
  paperA = await insertPaper(teacherA, 'A paper');
  paperB = await insertPaper(teacherB, 'B paper');
});

describe('0011_questions.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0011_questions.sql');
  });

  it('has row level security on both tables', async () => {
    for (const table of ['public.ingest_jobs', 'public.questions']) {
      const res = await db.admin.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where oid = $1::regclass`,
        [table],
      );
      expect(res.rows[0].relrowsecurity).toBe(true);
    }
  });
});

describe('ingest_jobs', () => {
  it('starts queued, with no attempt and no question yet', async () => {
    const id = await insertJob(teacherA, paperA);
    const res = await db.admin.query<{
      status: string;
      attempts: number;
      question_count: number;
      error: string | null;
    }>(
      `select status, attempts, question_count, error
       from public.ingest_jobs where id = $1`,
      [id],
    );
    expect(res.rows[0]).toEqual({
      status: 'queued',
      attempts: 0,
      question_count: 0,
      error: null,
    });
  });

  it('refuses a status that is not one of the four', async () => {
    await expect(insertJob(teacherA, paperA, 'splitting')).rejects.toThrow();
  });

  it('is read by its own teacher and by nobody else', async () => {
    await insertJob(teacherA, paperA);

    const mine = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query('select id from public.ingest_jobs');
      return res.rows;
    });
    expect(mine).toHaveLength(1);

    for (const other of [teacherB, student]) {
      const seen = await db.asUser(other, async (sql) => {
        const res = await sql.query('select id from public.ingest_jobs');
        return res.rows;
      });
      expect(seen).toEqual([]);
    }
  });

  it('cannot be queued under another teacher name', async () => {
    await expect(
      db.asUser(teacherB, async (sql) => {
        await sql.query(
          `insert into public.ingest_jobs (teacher_id, paper_id, pdf_path)
           values ($1, $2, 'papers/q.pdf')`,
          [teacherA, paperA],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('goes away with its paper', async () => {
    const id = await insertJob(teacherA, paperA);
    await db.admin.query('delete from public.papers where id = $1', [paperA]);
    const res = await db.admin.query('select id from public.ingest_jobs where id = $1', [id]);
    expect(res.rows).toEqual([]);
  });
});

describe('questions: the shape of a question', () => {
  it('needs exactly 4 options', async () => {
    await expect(
      insertQuestion(teacherA, paperA, { options: JSON.stringify(['a', 'b', 'c']) }),
    ).rejects.toThrow();

    await expect(
      insertQuestion(teacherA, paperA, { options: JSON.stringify(['a', 'b', 'c', 'd', 'e']) }),
    ).rejects.toThrow();

    const ok = await insertQuestion(teacherA, paperA, {
      options: JSON.stringify(['a', 'b', 'c', 'd']),
    });
    expect(ok).toBeTruthy();
  });

  it('refuses options that are not four filled-in strings', async () => {
    await expect(
      insertQuestion(teacherA, paperA, { options: JSON.stringify(['a', 'b', 'c', 7]) }),
    ).rejects.toThrow();

    await expect(
      insertQuestion(teacherA, paperA, { options: JSON.stringify(['a', 'b', 'c', '']) }),
    ).rejects.toThrow();

    await expect(
      insertQuestion(teacherA, paperA, { options: JSON.stringify({ a: 1 }) }),
    ).rejects.toThrow();
  });

  it('refuses a correct answer outside 0 to 3', async () => {
    await expect(insertQuestion(teacherA, paperA, { correctIdx: 4 })).rejects.toThrow();
    await expect(insertQuestion(teacherA, paperA, { correctIdx: -1 })).rejects.toThrow();
  });

  it('refuses a blank stem', async () => {
    await expect(insertQuestion(teacherA, paperA, { stem: '   ' })).rejects.toThrow();
  });

  it('refuses a language that is not en or hi', async () => {
    await expect(insertQuestion(teacherA, paperA, { lang: 'ta' })).rejects.toThrow();
  });

  it('belongs to a paper OR a test, never both and never neither', async () => {
    const testId = '77777777-7777-4777-8777-777777777777';

    // Neither.
    await expect(insertQuestion(teacherA, null, {})).rejects.toThrow();
    // Both.
    await expect(insertQuestion(teacherA, paperA, { testId })).rejects.toThrow();
    // A test question: paper_id null, test_id set. The FK for test_id arrives
    // in issue 15, so it is a plain uuid here.
    const id = await insertQuestion(teacherA, null, { testId });
    expect(id).toBeTruthy();
  });

  it('starts as an unchecked draft, because the split is not trusted', async () => {
    const id = await insertQuestion(teacherA, paperA, {});
    const res = await db.admin.query<{ checked: boolean; status: string }>(
      'select checked, status from public.questions where id = $1',
      [id],
    );
    expect(res.rows[0]).toEqual({ checked: false, status: 'draft' });
  });

  it('can never be live and unchecked at the same time (V9)', async () => {
    await expect(
      insertQuestion(teacherA, paperA, { status: 'live', checked: false }),
    ).rejects.toThrow();
  });

  it('refuses the same question number twice in one paper', async () => {
    await insertQuestion(teacherA, paperA, { number: 3 });
    await expect(insertQuestion(teacherA, paperA, { number: 3 })).rejects.toThrow();
  });

  it('refuses a question hung on another teacher paper', async () => {
    // teacher_id + paper_id must be a real (owner, paper) pair in `papers`.
    await expect(insertQuestion(teacherA, paperB, {})).rejects.toThrow();
  });
});

describe('questions: who may read them', () => {
  it('hides a draft question from a student', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, status: 'draft' });
    await insertQuestion(teacherA, paperA, {
      number: 2,
      status: 'live',
      checked: true,
      stem: 'A published one',
    });

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ stem: string }>('select stem from public.questions');
      return res.rows;
    });
    expect(seen).toEqual([{ stem: 'A published one' }]);
  });

  it('hides a draft question from another teacher as well', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, status: 'draft' });

    const seen = await db.asUser(teacherB, async (sql) => {
      const res = await sql.query('select id from public.questions');
      return res.rows;
    });
    expect(seen).toEqual([]);
  });

  it('shows a teacher their own drafts', async () => {
    await insertQuestion(teacherA, paperA, { number: 1 });
    const mine = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query('select id from public.questions');
      return res.rows;
    });
    expect(mine).toHaveLength(1);
  });

  it('shows nothing at all to a visitor who is not signed in', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, status: 'live', checked: true });
    const seen = await db.asAnon(async (sql) => {
      const res = await sql.query('select id from public.questions');
      return res.rows;
    });
    expect(seen).toEqual([]);
  });
});

describe('questions: who may edit them', () => {
  it('lets a teacher edit and check their own question', async () => {
    const id = await insertQuestion(teacherA, paperA, { number: 1 });

    await db.asUser(teacherA, async (sql) => {
      await sql.query(
        `update public.questions
         set stem = 'Fixed by the teacher', checked = true
         where id = $1`,
        [id],
      );
    });

    const res = await db.admin.query<{ stem: string; checked: boolean }>(
      'select stem, checked from public.questions where id = $1',
      [id],
    );
    expect(res.rows[0]).toEqual({ stem: 'Fixed by the teacher', checked: true });
  });

  it('refuses teacher B editing teacher A questions', async () => {
    const id = await insertQuestion(teacherA, paperA, { number: 1 });

    await db.asUser(teacherB, async (sql) => {
      await sql.query(`update public.questions set stem = 'stolen', checked = true`);
      await sql.query('delete from public.questions');
    });

    const res = await db.admin.query<{ stem: string; checked: boolean }>(
      'select stem, checked from public.questions where id = $1',
      [id],
    );
    expect(res.rows[0].checked).toBe(false);
    expect(res.rows[0].stem).not.toBe('stolen');
  });

  it('refuses a student writing a question', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.questions
             (teacher_id, paper_id, number, stem, options, correct_idx)
           values ($1, $2, 1, 'Planted', $3::jsonb, 0)`,
          [student, paperA, OPTIONS],
        );
      }),
    ).rejects.toThrow();
  });

  it('refuses a teacher handing their question to somebody else', async () => {
    const id = await insertQuestion(teacherA, paperA, { number: 1 });
    await expect(
      db.asUser(teacherA, async (sql) => {
        await sql.query('update public.questions set teacher_id = $1 where id = $2', [
          teacherB,
          id,
        ]);
      }),
    ).rejects.toThrow();
  });
});

describe('publish_paper()', () => {
  it('is refused while one question is still unchecked', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, checked: true });
    await insertQuestion(teacherA, paperA, { number: 2, checked: false });

    await expect(publishAs(teacherA, paperA)).rejects.toThrow(/unchecked/i);

    // Nothing moved: not the paper, and not the question that WAS checked.
    expect(await paperStatus(paperA)).toBe('draft');
    expect((await storedQuestions(paperA)).map((q) => q.status)).toEqual(['draft', 'draft']);
  });

  it('sets the paper and every question live in one go', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, checked: true });
    await insertQuestion(teacherA, paperA, { number: 2, checked: true });
    await insertQuestion(teacherA, paperA, { number: 3, checked: true });

    expect(await publishAs(teacherA, paperA)).toBe(3);

    expect(await paperStatus(paperA)).toBe('live');
    expect((await storedQuestions(paperA)).map((q) => q.status)).toEqual([
      'live',
      'live',
      'live',
    ]);
  });

  it('is refused while the split job is still queued or running', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, checked: true });

    const job = await insertJob(teacherA, paperA, 'queued');
    await expect(publishAs(teacherA, paperA)).rejects.toThrow(/still/i);

    await db.admin.query(`update public.ingest_jobs set status = 'running' where id = $1`, [
      job,
    ]);
    await expect(publishAs(teacherA, paperA)).rejects.toThrow(/still/i);

    // A finished job is no longer in the way.
    await db.admin.query(
      `update public.ingest_jobs set status = 'done', question_count = 1 where id = $1`,
      [job],
    );
    expect(await publishAs(teacherA, paperA)).toBe(1);
    expect(await paperStatus(paperA)).toBe('live');
  });

  it('publishes a paper that has no questions, because the PDF is content too', async () => {
    expect(await publishAs(teacherA, paperA)).toBe(0);
    expect(await paperStatus(paperA)).toBe('live');
  });

  it('refuses a paper that belongs to somebody else', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, checked: true });

    await expect(publishAs(teacherB, paperA)).rejects.toThrow();

    expect(await paperStatus(paperA)).toBe('draft');
    expect((await storedQuestions(paperA))[0].status).toBe('draft');
  });

  it('refuses a student, even for a paper they can see', async () => {
    await db.admin.query(`update public.papers set status = 'live' where id = $1`, [paperA]);
    await expect(publishAs(student, paperA)).rejects.toThrow();
  });

  it('refuses a paper id that does not exist', async () => {
    await expect(publishAs(teacherA, '00000000-0000-4000-8000-000000000000')).rejects.toThrow();
  });

  it('leaves the other teacher paper and questions alone', async () => {
    await insertQuestion(teacherA, paperA, { number: 1, checked: true });
    await insertQuestion(teacherB, paperB, { number: 1, checked: true });

    await publishAs(teacherA, paperA);

    expect(await paperStatus(paperB)).toBe('draft');
    expect((await storedQuestions(paperB))[0].status).toBe('draft');
  });
});
