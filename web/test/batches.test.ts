/**
 * Batches: create, join by link or code, free sets (issue 19-batches).
 *
 * design.md V2 and V3:
 *
 *   V2 "teacher creates many batches. A student can be in many batches.
 *       Student joins by link or code. Teacher can remove a student."
 *   V3 "teacher picks which of their mock sets a batch gets free."
 *
 * The whole point of this slice is that `set_access` with source `batch` is
 * DERIVED, never typed in. Three things can change it:
 *
 *   * a student joins or leaves a batch   (`batch_members`)
 *   * a teacher adds or drops a free set  (`batch_sets`)
 *   * the batch itself goes away
 *
 * Every one of those is a trigger in `0019_batches.sql`, so there is no screen
 * and no route that can forget to keep the grant in step. This file is the
 * proof, in Postgres, with RLS on.
 *
 * The facts the definition of done names:
 *
 *   1. one student in 2 batches,
 *   2. joining grants the batch's sets,
 *   3. removal revokes them,
 *   4. teacher B cannot see teacher A's batches,
 *   5. a bad code shows a clear error.
 *
 * Plus the one a many-to-many lives or dies by: two batches that both give the
 * same set away, where leaving ONE must not take the set with it.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the batches and the sets under test. */
let teacherA: string;
/** A second approved teacher, so "mine" can be told apart from "a teacher's". */
let teacherB: string;
/** The student who joins. */
let student: string;
/** A second student, who joins nothing unless a test says so. */
let other: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

/** Teacher A's two live sets, and teacher B's one. */
let setA1: string;
let setA2: string;
let setB1: string;
/** A paid test (not the free sample) inside `setA1`, with one question. */
let testA1: string;

async function insertSet(teacher: string, title: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, 399, 'live')
     returning id`,
    [teacher, NET, title],
  );
  return res.rows[0].id;
}

/** One PAID test with one live question, so a grant is visible as questions. */
async function insertPaidTest(setId: string): Promise<string> {
  const test = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, is_free_sample)
     values ($1, 'Test 1', 1, false)
     returning id`,
    [setId],
  );
  const testId = test.rows[0].id;

  const owner = await db.admin.query<{ teacher_id: string }>(
    'select teacher_id from public.mock_sets where id = $1',
    [setId],
  );

  await db.admin.query(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx, checked, status)
     values ($1, null, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live')`,
    [owner.rows[0].teacher_id, testId, OPTIONS],
  );
  return testId;
}

/** Create a batch the way the teacher screen does: through RLS. */
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

/** Give one of the teacher's own sets away to a batch (V3). */
function addSet(teacher: string, batchId: string, setId: string): Promise<void> {
  return db.asUser(teacher, async (sql) => {
    await sql.query('insert into public.batch_sets (batch_id, set_id) values ($1, $2)', [
      batchId,
      setId,
    ]);
  });
}

function dropSet(teacher: string, batchId: string, setId: string): Promise<void> {
  return db.asUser(teacher, async (sql) => {
    await sql.query('delete from public.batch_sets where batch_id = $1 and set_id = $2', [
      batchId,
      setId,
    ]);
  });
}

/** Join by code, the one way a student gets in. Returns the batch id. */
function join(userId: string, code: string): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ joined: string }>(
      'select public.join_batch($1) as joined',
      [code],
    );
    return res.rows[0].joined;
  });
}

/** The teacher removes a student (V2). */
function removeMember(teacher: string, batchId: string, userId: string): Promise<void> {
  return db.asUser(teacher, async (sql) => {
    await sql.query('delete from public.batch_members where batch_id = $1 and user_id = $2', [
      batchId,
      userId,
    ]);
  });
}

/** Every set this user holds through a batch. */
async function batchGrants(userId: string): Promise<string[]> {
  const res = await db.admin.query<{ set_id: string }>(
    `select set_id from public.set_access
     where user_id = $1 and source = 'batch' and valid_until > now()
     order by set_id`,
    [userId],
  );
  return res.rows.map((row) => row.set_id);
}

/** How many questions of one test this user can actually read. */
function questionCount(userId: string, testId: string): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ n: number }>(
      'select count(*)::int as n from public.questions where test_id = $1',
      [testId],
    );
    return res.rows[0].n;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  teacherB = await db.createUser();
  student = await db.createUser();
  other = await db.createUser();

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
  await db.admin.query('delete from public.batches');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  setA1 = await insertSet(teacherA, 'Full length set 1');
  setA2 = await insertSet(teacherA, 'Full length set 2');
  setB1 = await insertSet(teacherB, 'Full length set 1');
  testA1 = await insertPaidTest(setA1);
});

describe('0019_batches.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0019_batches.sql');
  });

  it('has row level security on all three tables', async () => {
    for (const table of ['public.batches', 'public.batch_members', 'public.batch_sets']) {
      const res = await db.admin.query<{ relrowsecurity: boolean }>(
        'select relrowsecurity from pg_class where oid = $1::regclass',
        [table],
      );
      expect(res.rows[0].relrowsecurity, table).toBe(true);
    }
  });

  it('gives a new batch a join code with no ambiguous letters', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    // No O, 0, I or 1: the code is read off one phone and typed into another.
    expect(batch.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('never hands two batches the same code', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      codes.add((await createBatch(teacherA, 'Batch ' + i)).code);
    }
    expect(codes.size).toBe(12);
  });

  it('refuses a batch with a blank name', async () => {
    await expect(createBatch(teacherA, '   ')).rejects.toThrow();
  });
});

describe('joining a batch', () => {
  it('puts one student in TWO batches at once (V2)', async () => {
    const morning = await createBatch(teacherA, 'Morning batch');
    const evening = await createBatch(teacherA, 'Evening batch');

    await join(student, morning.code);
    await join(student, evening.code);

    const mine = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ batch_id: string }>(
        'select batch_id from public.batch_members where user_id = $1',
        [student],
      );
      return res.rows.map((row) => row.batch_id).sort();
    });
    expect(mine).toEqual([morning.id, evening.id].sort());
  });

  it('grants the batch free sets on the way in (V3)', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await addSet(teacherA, batch.id, setA2);

    expect(await batchGrants(student)).toEqual([]);
    expect(await questionCount(student, testA1)).toBe(0);

    await join(student, batch.code);

    expect(await batchGrants(student)).toEqual([setA1, setA2].sort());
    // The grant is only worth anything if it actually opens the questions.
    expect(await questionCount(student, testA1)).toBe(1);
  });

  it('grants a set added AFTER the student joined', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await join(student, batch.code);
    expect(await questionCount(student, testA1)).toBe(0);

    await addSet(teacherA, batch.id, setA1);

    expect(await batchGrants(student)).toEqual([setA1]);
    expect(await questionCount(student, testA1)).toBe(1);
  });

  it('grants nothing to a student who joined no batch', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);

    expect(await batchGrants(other)).toEqual([]);
    expect(await questionCount(other, testA1)).toBe(0);
  });

  it('accepts the code in lower case and with spaces around it', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    const joined = await join(student, '  ' + batch.code.toLowerCase() + ' ');
    expect(joined).toBe(batch.id);
  });

  it('is safe to join twice: one row, no error', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await join(student, batch.code);
    await join(student, batch.code);

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.batch_members where batch_id = $1',
      [batch.id],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it('answers a bad code with a clear error, not a silent nothing', async () => {
    await expect(join(student, 'ZZZZZZ')).rejects.toThrow(/join code/i);
    await expect(join(student, '')).rejects.toThrow(/join code/i);
  });

  it('refuses to join anybody who is not signed in', async () => {
    await expect(
      db.asAnon(async (sql) => {
        await sql.query('select public.join_batch($1)', ['ABCDEF']);
      }),
    ).rejects.toThrow();
  });
});

describe('losing the batch', () => {
  it('revokes the sets when the teacher removes the student (V2)', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);
    expect(await questionCount(student, testA1)).toBe(1);

    await removeMember(teacherA, batch.id, student);

    expect(await batchGrants(student)).toEqual([]);
    expect(await questionCount(student, testA1)).toBe(0);
  });

  it('revokes the set when the teacher drops it from the batch', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);

    await dropSet(teacherA, batch.id, setA1);

    expect(await batchGrants(student)).toEqual([]);
    expect(await questionCount(student, testA1)).toBe(0);
  });

  it('revokes the sets when the whole batch is deleted', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);

    await db.asUser(teacherA, async (sql) => {
      await sql.query('delete from public.batches where id = $1', [batch.id]);
    });

    expect(await batchGrants(student)).toEqual([]);
    expect(await questionCount(student, testA1)).toBe(0);
  });

  it('revokes when the student leaves on their own', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);

    await db.asUser(student, async (sql) => {
      await sql.query('delete from public.batch_members where user_id = $1', [student]);
    });

    expect(await batchGrants(student)).toEqual([]);
  });

  it('KEEPS the set when a second batch still gives it away', async () => {
    const morning = await createBatch(teacherA, 'Morning batch');
    const evening = await createBatch(teacherA, 'Evening batch');
    await addSet(teacherA, morning.id, setA1);
    await addSet(teacherA, evening.id, setA1);

    await join(student, morning.code);
    await join(student, evening.code);
    expect(await batchGrants(student)).toEqual([setA1]);

    await removeMember(teacherA, morning.id, student);

    // Still in the evening batch, so the set stays open.
    expect(await batchGrants(student)).toEqual([setA1]);
    expect(await questionCount(student, testA1)).toBe(1);

    await removeMember(teacherA, evening.id, student);
    expect(await batchGrants(student)).toEqual([]);
  });

  it('leaves a PURCHASE alone when the batch goes', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);

    // What issues 26 and 27 will write. `source` is in the primary key, so a
    // batch leaving must not take a paid set with it.
    await db.admin.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'purchase', 'infinity')`,
      [student, setA1],
    );

    await removeMember(teacherA, batch.id, student);

    expect(await batchGrants(student)).toEqual([]);
    expect(await questionCount(student, testA1)).toBe(1);
  });
});

describe('one teacher never sees another teacher batch', () => {
  it('hides teacher A batch from teacher B', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');

    const seen = await db.asUser(teacherB, async (sql) => {
      const res = await sql.query('select id from public.batches');
      return res.rows;
    });
    expect(seen).toHaveLength(0);

    const mine = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ id: string }>('select id from public.batches');
      return res.rows.map((row) => row.id);
    });
    expect(mine).toEqual([batch.id]);
  });

  it('refuses teacher B a batch owned by teacher A', async () => {
    await expect(
      db.asUser(teacherB, async (sql) => {
        await sql.query(`insert into public.batches (teacher_id, name) values ($1, 'Stolen')`, [
          teacherA,
        ]);
      }),
    ).rejects.toThrow();
  });

  it('refuses teacher B a set inside teacher A batch', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await expect(addSet(teacherB, batch.id, setB1)).rejects.toThrow();
  });

  it('refuses teacher A giving away a set that is not theirs', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await expect(addSet(teacherA, batch.id, setB1)).rejects.toThrow();
  });

  it('refuses teacher B removing teacher A student', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);

    await removeMember(teacherB, batch.id, student);

    // The DELETE matched no row, so the student is still in and still holds
    // the set.
    expect(await batchGrants(student)).toEqual([setA1]);
  });

  it('lets the teacher see who is in their own batch', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await join(student, batch.code);
    await join(other, batch.code);

    const members = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ user_id: string }>(
        'select user_id from public.batch_members where batch_id = $1',
        [batch.id],
      );
      return res.rows.map((row) => row.user_id).sort();
    });
    expect(members).toEqual([student, other].sort());
  });
});

describe('what a student may do by hand', () => {
  it('cannot add itself to a batch without the code', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('insert into public.batch_members (batch_id, user_id) values ($1, $2)', [
          batch.id,
          student,
        ]);
      }),
    ).rejects.toThrow();
  });

  it('cannot give itself a set by writing batch_sets', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await join(student, batch.code);
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query('insert into public.batch_sets (batch_id, set_id) values ($1, $2)', [
          batch.id,
          setA1,
        ]);
      }),
    ).rejects.toThrow();
  });

  it('cannot write a batch set_access row by hand', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.set_access (user_id, set_id, source, valid_until)
           values ($1, $2, 'batch', 'infinity')`,
          [student, setA1],
        );
      }),
    ).rejects.toThrow();
  });

  it('sees the batch it joined, and never one it did not', async () => {
    const mine = await createBatch(teacherA, 'Morning batch');
    await createBatch(teacherA, 'Evening batch');
    await join(student, mine.code);

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>('select id from public.batches');
      return res.rows.map((row) => row.id);
    });
    expect(seen).toEqual([mine.id]);
  });

  it('cannot remove another student from a batch', async () => {
    const batch = await createBatch(teacherA, 'Morning batch');
    await addSet(teacherA, batch.id, setA1);
    await join(student, batch.code);
    await join(other, batch.code);

    await db.asUser(other, async (sql) => {
      await sql.query('delete from public.batch_members where user_id = $1', [student]);
    });

    expect(await batchGrants(student)).toEqual([setA1]);
  });
});
