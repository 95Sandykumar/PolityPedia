/**
 * Batch score reports (issue 20-batch-reports).
 *
 * F-B4: "Teacher sees batch scores (per test and per student) on their own
 * tests only." design.md V3: "Teacher sees batch scores."
 *
 * 0013_attempts.sql wrote the promise this file keeps:
 *
 *   "PRIVACY. An attempt is a student's score. NOBODY else reads it [...]
 *    Teacher reporting over batches is a later issue and will go through an
 *    owner-rights view, the way `teachers_public` does in 0005, never by
 *    widening these policies."
 *
 * So the report is TWO OWNER-RIGHTS VIEWS, and the `attempts` policies are
 * untouched. Each view carries its own `batch_id` column and its own
 * `teacher_id = auth.uid()` filter, which is what makes "their own tests only"
 * a fact in Postgres rather than a filter a route could forget.
 *
 * The three facts the definition of done names:
 *
 *   1. teacher A sees member scores on their OWN tests,
 *   2. teacher A sees NOTHING about teacher B's tests, even when the score
 *      belongs to a student sitting in teacher A's own batch,
 *   3. teacher B sees NOTHING of batch A.
 *
 * Plus the four a report lives or dies by: a student reads none of it, an
 * unsubmitted sitting is not a score, the newest submitted sitting is the one
 * reported, and a removed student leaves the report with them.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy and every view's rights for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns batch A, set A and the tests under report. */
let teacherA: string;
/** A second approved teacher, so "my tests" can be told from "a teacher's". */
let teacherB: string;
/** Two students in batch A. */
let studentOne: string;
let studentTwo: string;
/** A student in teacher B's batch only. */
let outsider: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

let setA: string;
let setB: string;
/** Two tests inside teacher A's set, so the report has two columns. */
let testA1: string;
let testA2: string;
/** Teacher B's test. Teacher A must never see a score on it. */
let testB1: string;

let batchA: string;
let batchB: string;

async function insertSet(teacher: string, title: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, 399, 'live')
     returning id`,
    [teacher, NET, title],
  );
  return res.rows[0].id;
}

async function insertTest(setId: string, title: string, position: number): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, is_free_sample)
     values ($1, $2, $3, false)
     returning id`,
    [setId, title, position],
  );
  return res.rows[0].id;
}

/** A batch, made the way the teacher screen makes one: through RLS. */
function createBatch(teacher: string, name: string): Promise<{ id: string; code: string }> {
  return db.asUser(teacher, async (sql) => {
    const res = await sql.query<{ id: string; join_code: string }>(
      `insert into public.batches (teacher_id, name)
       values ($1, $2)
       returning id, join_code`,
      [teacher, name],
    );
    return { id: res.rows[0].id, code: res.rows[0].join_code };
  });
}

function addSet(teacher: string, batchId: string, setId: string): Promise<void> {
  return db.asUser(teacher, async (sql) => {
    await sql.query('insert into public.batch_sets (batch_id, set_id) values ($1, $2)', [
      batchId,
      setId,
    ]);
  });
}

function join(userId: string, code: string): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ joined: string }>('select public.join_batch($1) as joined', [
      code,
    ]);
    return res.rows[0].joined;
  });
}

/**
 * One sitting. A null `submittedAt` is a sitting still open, and a null score
 * is a sitting nobody has marked: neither is a score, and neither may reach a
 * report.
 */
async function sit(
  userId: string,
  testId: string,
  score: number | null,
  submittedAt: string | null = '2026-11-01T10:00:00Z',
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.attempts (user_id, paper_id, test_id, mode, submitted_at, score)
     values ($1, null, $2, 'exam', $3, $4)
     returning id`,
    [userId, testId, submittedAt, score],
  );
  return res.rows[0].id;
}

interface ScoreRow {
  batch_id: string;
  user_id: string;
  test_id: string;
  score: number;
  submitted_at: string;
}

interface TestRow {
  batch_id: string;
  test_id: string;
  set_id: string;
  set_title: string;
  test_title: string;
  test_position: number;
}

/** The cells of one batch's report, as that caller may read them. */
function readScores(caller: string, batchId: string): Promise<ScoreRow[]> {
  return db.asUser(caller, async (sql) => {
    const res = await sql.query<ScoreRow>(
      `select * from public.batch_report_scores
       where batch_id = $1
       order by user_id, test_id`,
      [batchId],
    );
    return res.rows;
  });
}

/** Every cell this caller may read, whichever batch it belongs to. */
function readAllScores(caller: string): Promise<ScoreRow[]> {
  return db.asUser(caller, async (sql) => {
    const res = await sql.query<ScoreRow>('select * from public.batch_report_scores');
    return res.rows;
  });
}

/** The columns of one batch's report. */
function readTests(caller: string, batchId: string): Promise<TestRow[]> {
  return db.asUser(caller, async (sql) => {
    const res = await sql.query<TestRow>(
      `select * from public.batch_report_tests
       where batch_id = $1
       order by test_position`,
      [batchId],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  teacherB = await db.createUser();
  studentOne = await db.createUser();
  studentTwo = await db.createUser();
  outsider = await db.createUser();

  for (const teacher of [teacherA, teacherB]) {
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', 'Polity Guru', 'approved')`,
      [teacher],
    );
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.batches');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  setA = await insertSet(teacherA, 'Full length set 1');
  setB = await insertSet(teacherB, 'Full length set 1');
  testA1 = await insertTest(setA, 'Test 1', 1);
  testA2 = await insertTest(setA, 'Test 2', 2);
  testB1 = await insertTest(setB, 'Test 1', 1);

  const a = await createBatch(teacherA, 'Morning batch');
  const b = await createBatch(teacherB, 'Evening batch');
  batchA = a.id;
  batchB = b.id;

  await addSet(teacherA, batchA, setA);
  await addSet(teacherB, batchB, setB);

  await join(studentOne, a.code);
  await join(studentTwo, a.code);
  await join(outsider, b.code);
});

describe('0020_batch_reports.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0020_batch_reports.sql');
  });

  it('leaves both report views read only, so a join cannot be written through', async () => {
    for (const view of ['batch_report_scores', 'batch_report_tests']) {
      const res = await db.admin.query<{ privilege_type: string }>(
        `select distinct privilege_type
         from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name = $1
           and grantee = 'authenticated'
         order by privilege_type`,
        [view],
      );
      expect(res.rows.map((row) => row.privilege_type)).toEqual(['SELECT']);
    }
  });

  it('does NOT widen the attempts policies: a teacher still reads no attempt row', async () => {
    await sit(studentOne, testA1, 120);

    const seen = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ n: number }>(
        'select count(*)::int as n from public.attempts',
      );
      return res.rows[0].n;
    });
    expect(seen).toBe(0);
  });
});

describe('what teacher A sees (F-B4)', () => {
  it('sees a score per student per test on their own tests', async () => {
    await sit(studentOne, testA1, 120);
    await sit(studentOne, testA2, 96);
    await sit(studentTwo, testA1, 64);

    const rows = await readScores(teacherA, batchA);
    const seen = rows.map((row) => ({ user: row.user_id, test: row.test_id, score: row.score }));
    const want = [
      { user: studentOne, test: testA1, score: 120 },
      { user: studentOne, test: testA2, score: 96 },
      { user: studentTwo, test: testA1, score: 64 },
    ].sort((x, y) => x.user.localeCompare(y.user) || x.test.localeCompare(y.test));

    expect(seen).toEqual(want);
  });

  it('gets one column per test of the sets the batch gets free', async () => {
    const rows = await readTests(teacherA, batchA);
    expect(rows.map((row) => row.test_id)).toEqual([testA1, testA2]);
    expect(rows[0].set_id).toBe(setA);
    expect(rows[0].test_title).toBe('Test 1');
    expect(rows[0].set_title).toBe('Full length set 1');
  });

  it('sees NOTHING on a teacher B test, even for their own batch member', async () => {
    // Student one is in batch A, and also sat teacher B's test somewhere else.
    await sit(studentOne, testA1, 120);
    await sit(studentOne, testB1, 180);

    const rows = await readScores(teacherA, batchA);
    expect(rows.map((row) => row.test_id)).toEqual([testA1]);

    // And teacher B's test is not a column of teacher A's report either.
    const columns = await readTests(teacherA, batchA);
    expect(columns.every((row) => row.test_id !== testB1)).toBe(true);
  });

  it('counts the NEWEST submitted sitting, so a report cannot hide a drop', async () => {
    await sit(studentOne, testA1, 150, '2026-10-01T10:00:00Z');
    await sit(studentOne, testA1, 70, '2026-11-01T10:00:00Z');

    const rows = await readScores(teacherA, batchA);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(70);
  });

  it('does not report a sitting that is still open or has no score yet', async () => {
    await sit(studentOne, testA1, null, null);
    await sit(studentTwo, testA1, null, '2026-11-01T10:00:00Z');

    expect(await readScores(teacherA, batchA)).toEqual([]);
  });

  it('loses a removed student score with the student (V2)', async () => {
    await sit(studentOne, testA1, 120);
    expect(await readScores(teacherA, batchA)).toHaveLength(1);

    await db.asUser(teacherA, async (sql) => {
      await sql.query('delete from public.batch_members where batch_id = $1 and user_id = $2', [
        batchA,
        studentOne,
      ]);
    });

    expect(await readScores(teacherA, batchA)).toEqual([]);
  });
});

describe('what everybody else sees', () => {
  it('teacher B sees NOTHING of batch A', async () => {
    await sit(studentOne, testA1, 120);
    await sit(studentTwo, testA1, 64);

    expect(await readScores(teacherB, batchA)).toEqual([]);
    expect(await readTests(teacherB, batchA)).toEqual([]);

    // Not even without a batch filter: the view carries its own owner test.
    const everything = await readAllScores(teacherB);
    expect(everything.every((row) => row.batch_id !== batchA)).toBe(true);
  });

  it('teacher B still sees their own batch', async () => {
    await sit(outsider, testB1, 88);

    const rows = await readScores(teacherB, batchB);
    expect(rows.map((row) => ({ user: row.user_id, score: row.score }))).toEqual([
      { user: outsider, score: 88 },
    ]);
  });

  it('a student reads no report at all, not even their own batch', async () => {
    await sit(studentOne, testA1, 120);

    expect(await readScores(studentOne, batchA)).toEqual([]);
    expect(await readTests(studentOne, batchA)).toEqual([]);
    expect(await readAllScores(studentOne)).toEqual([]);
  });

  it('refuses a visitor who is not signed in outright', async () => {
    await sit(studentOne, testA1, 120);

    // `anon` was never granted SELECT, so this is a permission error and not
    // an empty list. Stricter than the signed-in case on purpose: a report is
    // never a public page, so there is nothing for a visitor to ask.
    await expect(
      db.asAnon(async (sql) => {
        await sql.query('select * from public.batch_report_scores');
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asAnon(async (sql) => {
        await sql.query('select * from public.batch_report_tests');
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
