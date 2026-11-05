/**
 * Mock sets, mock tests and publish (issue 15-mock-sets-authoring).
 *
 * Design constraint V11: a mock set is priced BY THE TEACHER, between Rs 299
 * and Rs 399, and Test 1 may be a free sample. X3: the teacher's share is on
 * the net amount. AS6: GST 18% sits inside the price and the gateway fee is
 * about 2% (unverified).
 *
 * This file proves, in Postgres, where the rules have to live:
 *
 *  1. `price_inr` 298 and 400 are REFUSED; 299 and 399 are stored.
 *  2. only POSITION 1 may be a free sample (V11: "Test 1 can be free").
 *  3. teacher B can neither read nor edit teacher A's draft set.
 *  4. a student reads a LIVE set of an approved teacher, never a draft.
 *  5. `questions.test_id` is now a real FOREIGN KEY to `mock_tests`
 *     (issue 11 left it a plain uuid on purpose), and a question cannot be
 *     hung on another teacher's test.
 *  6. `publish_mock_set()` refuses an empty set, refuses while one question is
 *     unchecked, refuses somebody else's set, and otherwise moves the
 *     questions AND the set in ONE transaction.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the sets in most tests below. */
let teacherA: string;
/** A second approved teacher. The attacker in the privacy tests. */
let teacherB: string;
/** A plain student. Reads live sets, writes nothing. */
let student: string;

/** Two exams from the 0004 seed, by their fixed ids. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

async function insertSet(
  teacherId: string,
  values: {
    examId?: string;
    title?: string;
    priceInr?: number;
    status?: string;
  } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      teacherId,
      values.examId ?? NET,
      values.title ?? 'Full length set 1',
      values.priceInr ?? 299,
      values.status ?? 'draft',
    ],
  );
  return res.rows[0].id;
}

async function insertTest(
  setId: string,
  values: {
    title?: string;
    position?: number;
    durationMin?: number;
    isFreeSample?: boolean;
  } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      setId,
      values.title ?? 'Test 1',
      values.position ?? 1,
      values.durationMin ?? 60,
      values.isFreeSample ?? false,
    ],
  );
  return res.rows[0].id;
}

async function insertQuestion(
  teacherId: string,
  testId: string,
  values: { number?: number; checked?: boolean } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx, checked)
     values ($1, null, $2, $3, 'Which house is the Council of States?', $4::jsonb, 1, $5)
     returning id`,
    [teacherId, testId, values.number ?? 1, OPTIONS, values.checked ?? false],
  );
  return res.rows[0].id;
}

/** Reads with the owner handle, so RLS never hides a row the test asserts on. */
async function setStatus(setId: string): Promise<string | null> {
  const res = await db.admin.query<{ status: string }>(
    'select status from public.mock_sets where id = $1',
    [setId],
  );
  return res.rows[0]?.status ?? null;
}

async function questionStatuses(setId: string): Promise<string[]> {
  const res = await db.admin.query<{ status: string }>(
    `select q.status
     from public.questions q
     join public.mock_tests t on t.id = q.test_id
     where t.set_id = $1
     order by q.number`,
    [setId],
  );
  return res.rows.map((one) => one.status);
}

/** Call `publish_mock_set()` as the given user, exactly the way the app does. */
function publishAs(userId: string, setId: string): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ published: number }>(
      'select public.publish_mock_set($1) as published',
      [setId],
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
  // Questions first: they point at the tests, which point at the sets.
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');
});

describe('0015_mock_sets.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0015_mock_sets.sql');
  });

  it('has row level security on both tables', async () => {
    for (const table of ['public.mock_sets', 'public.mock_tests']) {
      const res = await db.admin.query<{ relrowsecurity: boolean }>(
        'select relrowsecurity from pg_class where oid = $1::regclass',
        [table],
      );
      expect(res.rows[0].relrowsecurity).toBe(true);
    }
  });
});

describe('mock_sets.price_inr (V11: Rs 299 to Rs 399)', () => {
  it('refuses Rs 298, one rupee under the floor', async () => {
    await expect(insertSet(teacherA, { priceInr: 298 })).rejects.toThrow();
  });

  it('refuses Rs 400, one rupee over the ceiling', async () => {
    await expect(insertSet(teacherA, { priceInr: 400 })).rejects.toThrow();
  });

  it('stores both ends of the range', async () => {
    const low = await insertSet(teacherA, { priceInr: 299, title: 'Low' });
    const high = await insertSet(teacherA, { priceInr: 399, title: 'High' });

    const res = await db.admin.query<{ price_inr: number }>(
      'select price_inr from public.mock_sets where id = any($1) order by price_inr',
      [[low, high]],
    );
    expect(res.rows.map((one) => one.price_inr)).toEqual([299, 399]);
  });

  it('starts as a DRAFT, because nothing is live before the teacher publishes', async () => {
    const id = await insertSet(teacherA, {});
    expect(await setStatus(id)).toBe('draft');
  });

  it('refuses a status it does not know', async () => {
    await expect(insertSet(teacherA, { status: 'published' })).rejects.toThrow();
  });

  it('refuses a blank title, and allows the same title under another exam', async () => {
    await expect(insertSet(teacherA, { title: '   ' })).rejects.toThrow();

    await insertSet(teacherA, { title: 'Set 1', examId: NET });
    const other = await insertSet(teacherA, { title: 'Set 1', examId: CUET });
    expect(other).toBeTruthy();

    // The same title twice under the SAME exam is the same set.
    await expect(insertSet(teacherA, { title: 'Set 1', examId: NET })).rejects.toThrow();
  });
});

describe('mock_tests', () => {
  it('lets ONLY position 1 be the free sample (V11)', async () => {
    const setId = await insertSet(teacherA, {});

    const first = await insertTest(setId, { position: 1, isFreeSample: true });
    expect(first).toBeTruthy();

    await expect(
      insertTest(setId, { title: 'Test 2', position: 2, isFreeSample: true }),
    ).rejects.toThrow();

    // Position 2 is fine as long as it is not a free sample.
    const paid = await insertTest(setId, { title: 'Test 2', position: 2 });
    expect(paid).toBeTruthy();
  });

  it('keeps one test per position inside a set', async () => {
    const setId = await insertSet(teacherA, {});
    await insertTest(setId, { position: 1 });
    await expect(insertTest(setId, { title: 'Clash', position: 1 })).rejects.toThrow();
  });

  it('refuses a position or a duration outside the range', async () => {
    const setId = await insertSet(teacherA, {});
    await expect(insertTest(setId, { position: 0 })).rejects.toThrow();
    await expect(insertTest(setId, { durationMin: 0 })).rejects.toThrow();
  });

  it('goes away with its set', async () => {
    const setId = await insertSet(teacherA, {});
    await insertTest(setId, {});
    await db.admin.query('delete from public.mock_sets where id = $1', [setId]);

    const res = await db.admin.query('select 1 from public.mock_tests where set_id = $1', [
      setId,
    ]);
    expect(res.rows).toHaveLength(0);
  });
});

describe('questions.test_id is a real foreign key now', () => {
  it('refuses a test id that is not a mock test', async () => {
    await expect(
      insertQuestion(teacherA, '77777777-7777-4777-8777-777777777777'),
    ).rejects.toThrow();
  });

  it('accepts a question on a real test, and drops it with the test', async () => {
    const setId = await insertSet(teacherA, {});
    const testId = await insertTest(setId, {});
    const questionId = await insertQuestion(teacherA, testId);
    expect(questionId).toBeTruthy();

    await db.admin.query('delete from public.mock_tests where id = $1', [testId]);
    const res = await db.admin.query('select 1 from public.questions where id = $1', [
      questionId,
    ]);
    expect(res.rows).toHaveLength(0);
  });

  it('refuses a question hung on ANOTHER teacher test', async () => {
    const setA = await insertSet(teacherA, {});
    const testA = await insertTest(setA, {});
    await expect(insertQuestion(teacherB, testA)).rejects.toThrow();
  });
});

describe('row level security', () => {
  it('teacher B can neither read nor edit teacher A draft set', async () => {
    const setId = await insertSet(teacherA, { title: 'A secret set' });

    const rows = await db.asUser(teacherB, async (sql) => {
      const res = await sql.query('select id from public.mock_sets where id = $1', [setId]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);

    // An UPDATE that matches no visible row changes nothing. Checked in the
    // stored row, not in the reply, so a silent no-op cannot pass as a pass.
    await db.asUser(teacherB, async (sql) => {
      await sql.query('update public.mock_sets set price_inr = 399 where id = $1', [setId]);
    });
    const res = await db.admin.query<{ price_inr: number }>(
      'select price_inr from public.mock_sets where id = $1',
      [setId],
    );
    expect(res.rows[0].price_inr).toBe(299);
  });

  it('teacher B cannot add a test to teacher A set', async () => {
    const setId = await insertSet(teacherA, {});

    await expect(
      db.asUser(teacherB, async (sql) => {
        await sql.query(
          `insert into public.mock_tests (set_id, title, position) values ($1, 'Mine now', 1)`,
          [setId],
        );
      }),
    ).rejects.toThrow();
  });

  it('a teacher reads, writes and prices their OWN set', async () => {
    const setId = await db.asUser(teacherA, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into public.mock_sets (teacher_id, exam_id, title, price_inr)
         values ($1, $2, 'My own set', 349)
         returning id`,
        [teacherA, NET],
      );
      return res.rows[0].id;
    });

    const price = await db.asUser(teacherA, async (sql) => {
      await sql.query('update public.mock_sets set price_inr = 359 where id = $1', [setId]);
      const res = await sql.query<{ price_inr: number }>(
        'select price_inr from public.mock_sets where id = $1',
        [setId],
      );
      return res.rows[0].price_inr;
    });
    expect(price).toBe(359);
  });

  it('a student reads a LIVE set and its tests, never a draft', async () => {
    const draft = await insertSet(teacherA, { title: 'Draft set' });
    const live = await insertSet(teacherA, { title: 'Live set', status: 'live' });
    await insertTest(live, { position: 1, isFreeSample: true });
    await insertTest(draft, { position: 1 });

    const seen = await db.asUser(student, async (sql) => {
      const sets = await sql.query<{ title: string }>(
        'select title from public.mock_sets order by title',
      );
      const tests = await sql.query('select id from public.mock_tests');
      return { sets: sets.rows.map((one) => one.title), tests: tests.rows.length };
    });

    expect(seen.sets).toEqual(['Live set']);
    expect(seen.tests).toBe(1);
  });

  it('a student writes nothing', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.mock_sets (teacher_id, exam_id, title)
           values ($1, $2, 'Not mine')`,
          [student, NET],
        );
      }),
    ).rejects.toThrow();
  });

  it('anon sees nothing', async () => {
    await insertSet(teacherA, { status: 'live' });
    const rows = await db.asAnon(async (sql) => {
      const res = await sql.query('select id from public.mock_sets');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe('publish_mock_set()', () => {
  it('refuses a set with no tests: there would be nothing to buy', async () => {
    const setId = await insertSet(teacherA, {});
    await expect(publishAs(teacherA, setId)).rejects.toThrow();
    expect(await setStatus(setId)).toBe('draft');
  });

  it('refuses while ONE question is unchecked, and moves nothing', async () => {
    const setId = await insertSet(teacherA, {});
    const testId = await insertTest(setId, {});
    await insertQuestion(teacherA, testId, { number: 1, checked: true });
    await insertQuestion(teacherA, testId, { number: 2, checked: false });

    await expect(publishAs(teacherA, setId)).rejects.toThrow();
    expect(await setStatus(setId)).toBe('draft');
    expect(await questionStatuses(setId)).toEqual(['draft', 'draft']);
  });

  it('moves every question AND the set in one go', async () => {
    const setId = await insertSet(teacherA, {});
    const one = await insertTest(setId, { position: 1, isFreeSample: true });
    const two = await insertTest(setId, { title: 'Test 2', position: 2 });
    await insertQuestion(teacherA, one, { number: 1, checked: true });
    await insertQuestion(teacherA, two, { number: 2, checked: true });

    expect(await publishAs(teacherA, setId)).toBe(2);
    expect(await setStatus(setId)).toBe('live');
    expect(await questionStatuses(setId)).toEqual(['live', 'live']);
  });

  it('refuses teacher B publishing teacher A set', async () => {
    const setId = await insertSet(teacherA, {});
    const testId = await insertTest(setId, {});
    await insertQuestion(teacherA, testId, { checked: true });

    await expect(publishAs(teacherB, setId)).rejects.toThrow();
    expect(await setStatus(setId)).toBe('draft');
  });

  it('refuses a set that does not exist', async () => {
    await expect(
      publishAs(teacherA, '88888888-8888-4888-8888-888888888888'),
    ).rejects.toThrow();
  });
});
