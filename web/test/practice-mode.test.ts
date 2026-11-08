/**
 * Practice mode for mock tests, in Postgres (issue 17-practice-mode).
 *
 * The definition of done: "A student starts a mock test in Practice mode (full
 * paper or one topic), sees right or wrong after each question in the shared
 * player, and gets a score at the end. The mock list then shows a tick and the
 * score."
 *
 * Five facts, and every one of them belongs in the database and not in a
 * component:
 *
 *  1. F-E4, THE TOPIC FILTER. One topic loads only that topic's questions, so
 *     the filter has to work against RLS and not after it.
 *  2. A sitting hangs on a REAL test. `attempts.test_id` had no foreign key
 *     until this slice, because `mock_tests` arrived in issue 15.
 *  3. PRACTICE HAS NO TIMER (F-E4). A deadline on a practice sitting would
 *     draw a timer the student was never promised, so it is a CHECK.
 *  4. A LOCKED TEST CANNOT BE STARTED. The questions were already refused by
 *     `0016_set_access.sql`; this slice refuses the empty sitting as well, so
 *     a locked test cannot leave a trail of attempts behind.
 *  5. THE TICK. The mock list reads the LATEST SUBMITTED sitting per test, so
 *     a submit is what puts the tick and the score on the row.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the set, its tests and their questions. */
let teacher: string;
/** The student who sits the mock test. */
let student: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';
/** CUET PG: +4 and -1, so marking is actually visible in a score. */
const CUET = 'a4000001-0000-4000-8000-000000000002';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

/** Two made-up topic ids. v1 has no topic catalogue yet (design.md). */
const TOPIC_A = 'c0000001-0000-4000-8000-00000000000a';
const TOPIC_B = 'c0000001-0000-4000-8000-00000000000b';

let setId: string;
/** Test 1, the free sample: open to everybody. */
let freeTest: string;
/** Test 2, paid: locked until `set_access` says otherwise. */
let paidTest: string;

async function insertSet(examId = CUET): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, 'live')
     returning id`,
    [teacher, examId],
  );
  return res.rows[0].id;
}

async function insertTest(values: {
  position: number;
  isFreeSample?: boolean;
}): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, is_free_sample)
     values ($1, $2, $3, $4)
     returning id`,
    [setId, 'Test ' + values.position, values.position, values.isFreeSample ?? false],
  );
  return res.rows[0].id;
}

/** One LIVE, CHECKED question on a test, in one topic. */
async function insertQuestion(
  testId: string,
  number: number,
  topicId: string | null,
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        topic_id, checked, status)
     values ($1, null, $2, $3, 'Which house is the Council of States?',
             $4::jsonb, 1, $5, true, 'live')
     returning id`,
    [teacher, testId, number, OPTIONS, topicId],
  );
  return res.rows[0].id;
}

/** Grant the set to a student, the way the admin screen does. */
function grant(userId: string, validUntil?: string): Promise<void> {
  return db.admin
    .query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'admin', $3::timestamptz)
       on conflict (user_id, set_id, source)
       do update set valid_until = excluded.valid_until`,
      [userId, setId, validUntil ?? new Date(Date.now() + 86_400_000).toISOString()],
    )
    .then(() => undefined);
}

/**
 * The exact read the start route makes: one sitting of one mock test, with the
 * topic filter the student chose.
 */
function startAttempt(
  userId: string,
  testId: string,
  values: { mode?: string; topicId?: string | null; deadlineAt?: string | null } = {},
): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode, topic_id, deadline_at)
       values ($1, null, $2, $3, $4, $5::timestamptz)
       returning id`,
      [
        userId,
        testId,
        values.mode ?? 'practice',
        values.topicId ?? null,
        values.deadlineAt ?? null,
      ],
    );
    return res.rows[0].id;
  });
}

/** The player's read: the questions of this test, for this topic. */
function readQuestions(
  userId: string,
  testId: string,
  topicId: string | null,
): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ n: number }>(
      `select count(*)::int as n from public.questions
       where test_id = $1 and ($2::uuid is null or topic_id = $2::uuid)`,
      [testId, topicId],
    );
    return res.rows[0].n;
  });
}

/**
 * Close a sitting, write-once.
 *
 * Written with the OWNER handle, because since `0031_attempt_score_guard.sql`
 * `attempts.score` and `attempts.submitted_at` belong to the server:
 * `score_attempt()` is the only writer, and a student's own PATCH is refused.
 * These tests are about the TICK on the mock list, so they take the server's
 * seat rather than re-testing the marking (`test/attempt-score-guard.test.ts`
 * covers the refusal, and `test/exam-mode.test.ts` the marking).
 */
function submit(userId: string, attemptId: string, score: number): Promise<number> {
  return db.admin
    .query(
      `update public.attempts
         set submitted_at = now(), score = $2
       where id = $1 and submitted_at is null and user_id = $3`,
      [attemptId, score, userId],
    )
    .then((res) => res.affectedRows ?? 0);
}

/**
 * What the mock list reads for the tick: the LATEST submitted sitting per
 * test, newest first (`listScores` in `supabase-set-access-client.ts`).
 */
function latestScores(
  userId: string,
  testIds: readonly string[],
): Promise<{ test_id: string; score: number | null }[]> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ test_id: string; score: number | null }>(
      `select test_id, score from public.attempts
       where user_id = $1
         and test_id = any($2::uuid[])
         and submitted_at is not null
       order by submitted_at desc`,
      [userId, testIds],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacher],
  );
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.papers');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  setId = await insertSet();
  freeTest = await insertTest({ position: 1, isFreeSample: true });
  paidTest = await insertTest({ position: 2 });
});

describe('the migration', () => {
  it('is applied in number order, after the mock sets it needs', async () => {
    expect(db.migrations).toContain('0017_practice_mode.sql');
    expect(db.migrations.indexOf('0017_practice_mode.sql')).toBeGreaterThan(
      db.migrations.indexOf('0015_mock_sets.sql'),
    );
  });
});

describe('the topic filter (F-E4)', () => {
  beforeEach(async () => {
    await insertQuestion(freeTest, 1, TOPIC_A);
    await insertQuestion(freeTest, 2, TOPIC_A);
    await insertQuestion(freeTest, 3, TOPIC_B);
  });

  it('loads only that topic s questions', async () => {
    expect(await readQuestions(student, freeTest, TOPIC_A)).toBe(2);
    expect(await readQuestions(student, freeTest, TOPIC_B)).toBe(1);
  });

  it('loads the whole paper when no topic is chosen', async () => {
    expect(await readQuestions(student, freeTest, null)).toBe(3);
  });

  it('still obeys the paywall: a locked test is empty whatever the topic', async () => {
    await insertQuestion(paidTest, 1, TOPIC_A);

    expect(await readQuestions(student, paidTest, TOPIC_A)).toBe(0);
    expect(await readQuestions(student, paidTest, null)).toBe(0);
  });

  it('stores the chosen topic on the sitting, so a resume reads the same list', async () => {
    const attempt = await startAttempt(student, freeTest, { topicId: TOPIC_A });

    const res = await db.admin.query<{ topic_id: string | null; mode: string }>(
      'select topic_id, mode from public.attempts where id = $1',
      [attempt],
    );
    expect(res.rows[0]).toEqual({ topic_id: TOPIC_A, mode: 'practice' });
  });
});

describe('a sitting of a mock test', () => {
  it('hangs on a real test, never a made-up id', async () => {
    await expect(
      startAttempt(student, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow();
  });

  it('is kept when its test is deleted: the test cannot be hard-deleted (0041)', async () => {
    // Before 0041 the sitting cascaded away with its test, which erased a
    // student's score. Now attempts.test_id is ON DELETE RESTRICT.
    const attempt = await startAttempt(student, freeTest);
    await expect(
      db.admin.query('delete from public.mock_tests where id = $1', [freeTest]),
    ).rejects.toThrow(/attempts_test_fkey/);

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.attempts where id = $1',
      [attempt],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it('carries no deadline in practice mode, because practice has no timer', async () => {
    await expect(
      startAttempt(student, freeTest, {
        mode: 'practice',
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toThrow();
  });

  it('leaves a deadline alone in exam mode, which is issue 18', async () => {
    const attempt = await startAttempt(student, freeTest, {
      mode: 'exam',
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(attempt).toBeTruthy();
  });

  it('keeps working for a past paper, which has no test at all', async () => {
    const paper = await db.admin.query<{ id: string }>(
      `insert into public.papers
         (teacher_id, exam_id, year, label, pdf_questions_path, status)
       values ($1, $2, 2024, 'UGC NET 2024 Paper 2', 'papers/q.pdf', 'live')
       returning id`,
      [teacher, NET],
    );
    const paperId = paper.rows[0].id;

    const started = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into public.attempts (user_id, paper_id, mode)
         values ($1, $2, 'practice') returning id`,
        [student, paperId],
      );
      return res.rows[0].id;
    });
    expect(started).toBeTruthy();
  });
});

describe('a locked test', () => {
  it('cannot be started at all', async () => {
    await expect(startAttempt(student, paidTest)).rejects.toThrow();
  });

  it('can be started once the set is granted', async () => {
    await grant(student);
    expect(await startAttempt(student, paidTest)).toBeTruthy();
  });

  it('cannot be started again once the grant has run out', async () => {
    await grant(student, new Date(Date.now() - 1_000).toISOString());
    await expect(startAttempt(student, paidTest)).rejects.toThrow();
  });

  it('is always open when it is the free sample', async () => {
    expect(await startAttempt(student, freeTest)).toBeTruthy();
  });
});

describe('the tick and the score on the mock list', () => {
  it('appears after a submit, and carries the marks', async () => {
    const attempt = await startAttempt(student, freeTest);

    // Nothing to show while the sitting is open.
    expect(await latestScores(student, [freeTest])).toEqual([]);

    // CUET PG marking: 10 right at +4 and 5 wrong at -1 is 35.
    expect(await submit(student, attempt, 35)).toBe(1);

    expect(await latestScores(student, [freeTest])).toEqual([
      { test_id: freeTest, score: 35 },
    ]);
  });

  it('shows the newest sitting, not a worse one from last month', async () => {
    const first = await startAttempt(student, freeTest);
    await submit(student, first, 12);
    const second = await startAttempt(student, freeTest);
    await submit(student, second, 35);

    const rows = await latestScores(student, [freeTest]);
    // Newest first, so the list takes the first row for the test.
    expect(rows[0]).toEqual({ test_id: freeTest, score: 35 });
  });

  it('keeps a score of zero, which is a real sitting and not an absent one', async () => {
    const attempt = await startAttempt(student, freeTest);
    await submit(student, attempt, 0);

    expect(await latestScores(student, [freeTest])).toEqual([
      { test_id: freeTest, score: 0 },
    ]);
  });

  it('cannot be moved by a replayed submit', async () => {
    const attempt = await startAttempt(student, freeTest);
    await submit(student, attempt, 35);

    // `submitted_at is null` makes the write once-only.
    expect(await submit(student, attempt, 300)).toBe(0);
    expect(await latestScores(student, [freeTest])).toEqual([
      { test_id: freeTest, score: 35 },
    ]);
  });

  it('is nobody else s business', async () => {
    const other = await db.createUser();
    const attempt = await startAttempt(student, freeTest);
    await submit(student, attempt, 35);

    expect(await latestScores(other, [freeTest])).toEqual([]);
  });
});
