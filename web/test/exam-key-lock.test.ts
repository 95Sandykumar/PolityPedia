/**
 * The answer key is NOT READABLE during an exam (issue 30-exam-key-lock).
 *
 * Issue 18 promised F-E5: "the phone is never given the key during an exam".
 * It kept that promise in TypeScript only. `examQuestions()` stripped
 * `correct_idx` out of the payload and the page never put it in a prop, but
 * the DATABASE still handed the column over, so a student in the middle of a
 * timed sitting could ask for it themselves:
 *
 *   GET {SUPABASE_URL}/rest/v1/questions?test_id=eq.<id>&select=number,correct_idx
 *
 * with the anon key and their own token, and get the whole key back. The same
 * student could also open the SAME test in PRACTICE mode in a second tab,
 * where the key ships by design, because `attempts_one_open_per_test_idx`
 * counts the mode and lets an exam sitting and a practice sitting coexist.
 *
 * So the rule moves into Postgres, where a browser cannot skip it:
 *
 *  1. NOBODY reads `questions.correct_idx` off the table any more. The column
 *     privilege is gone for `anon` and `authenticated`, so the REST request
 *     above is refused before RLS is even consulted.
 *  2. `question_keys(uuid[])` is the one way in. SECURITY DEFINER, it checks
 *     `auth.uid()`, the set paywall through `has_test_access()`, and REFUSES
 *     outright while the caller has an open exam sitting for that test.
 *  3. A PRACTICE sitting cannot be started for a test whose exam sitting is
 *     open, so the second tab has nowhere to write and never opens.
 *
 * What must NOT change: `score_attempt()` reads the key itself (it is
 * SECURITY DEFINER and owns the table), teachers still read and edit the key
 * of their own questions, and everything works normally after submit.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy and every column privilege for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the set, its tests and their questions. */
let teacher: string;
/** A second approved teacher, who owns none of it. */
let other: string;
/** The student who sits the timed test. */
let student: string;

/** CUET PG: +4 and -1 (the 0004 seed), so one right answer scores 4. */
const CUET = 'a4000001-0000-4000-8000-000000000002';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

let setId: string;
/** The free sample, so the paywall is never the thing doing the refusing. */
let testId: string;
/** A SECOND test of the same set, to prove the lock is per test. */
let otherTestId: string;

async function insertSet(examId: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, 'live')
     returning id`,
    [teacher, examId],
  );
  return res.rows[0].id;
}

/**
 * One test of the set. `mock_tests_free_sample_check` in 0015 only lets
 * position 1 be the sample, so test 2 is a paid one and the student is handed
 * a `set_access` row by the tests that need it.
 */
async function insertTest(title: string, position: number): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, $2, $3, 90, $4)
     returning id`,
    [setId, title, position, position === 1],
  );
  return res.rows[0].id;
}

/** The row an admin grant writes (0016): this user owns this set, forever. */
async function grantAccess(userId: string): Promise<void> {
  await db.admin.query(
    `insert into public.set_access (user_id, set_id, source, valid_until)
     values ($1, $2, 'admin', 'infinity')`,
    [userId, setId],
  );
}

/** One question of `test`, live and checked unless told otherwise. */
async function insertQuestion(
  test: string,
  number: number,
  correctIdx: number,
  status: 'draft' | 'live' = 'live',
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        teacher_explanation, checked, status)
     values ($1, null, $2, $3, 'Which house is the Council of States?',
             $4::jsonb, $5, 'Article 80 names it.', true, $6)
     returning id`,
    [teacher, test, number, OPTIONS, correctIdx, status],
  );
  return res.rows[0].id;
}

/** The exact insert the exam load route makes. */
function startExam(userId: string, test: string): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode, deadline_at)
       values ($1, null, $2, 'exam', now() + interval '90 minutes')
       returning id`,
      [userId, test],
    );
    return res.rows[0].id;
  });
}

/** The exact insert the practice page makes. */
function startPractice(userId: string, test: string): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode)
       values ($1, null, $2, 'practice')
       returning id`,
      [userId, test],
    );
    return res.rows[0].id;
  });
}

/** The REST request of scenario A, as SQL: the key straight off the table. */
function selectKeyDirectly(userId: string, test: string): Promise<unknown> {
  return db.asUser(userId, (sql) =>
    sql.query('select number, correct_idx from public.questions where test_id = $1', [test]),
  );
}

/** The new route in. Returns question id -> key. */
function questionKeys(userId: string, ids: string[]): Promise<Map<string, number>> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ question_id: string; correct_idx: number }>(
      'select question_id, correct_idx from public.question_keys($1::uuid[])',
      [ids],
    );
    return new Map(res.rows.map((row) => [row.question_id, row.correct_idx]));
  });
}

function scoreAttempt(userId: string, attemptId: string): Promise<number | null> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ score: number | null }>(
      'select public.score_attempt($1::uuid) as score',
      [attemptId],
    );
    return res.rows[0].score;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  other = await db.createUser();
  student = await db.createUser();

  for (const [user, alias] of [
    [teacher, 'Polity Guru'],
    [other, 'Other Guru'],
  ] as const) {
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', $2, 'approved')`,
      [user, alias],
    );
  }
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

  setId = await insertSet(CUET);
  testId = await insertTest('Test 1', 1);
  otherTestId = await insertTest('Test 2', 2);
});

describe('0030_exam_key_lock', () => {
  it('ships as a migration named for this issue', () => {
    expect(db.migrations).toContain('0030_exam_key_lock.sql');
  });

  // ------------------------------------------------------------------
  // 1. Scenario A: the key straight off the table
  // ------------------------------------------------------------------

  it('refuses a direct read of correct_idx to a student in an open exam', async () => {
    await insertQuestion(testId, 1, 1);
    await startExam(student, testId);

    await expect(selectKeyDirectly(student, testId)).rejects.toThrow();
  });

  it('refuses a direct read of correct_idx even with no sitting at all', async () => {
    await insertQuestion(testId, 1, 1);

    // The column privilege is gone for the ROLE, so there is no state of the
    // world in which the REST request of scenario A answers.
    await expect(selectKeyDirectly(student, testId)).rejects.toThrow();
  });

  it('refuses the teacher the same direct read, so there is one way in', async () => {
    await insertQuestion(testId, 1, 1, 'draft');
    await expect(selectKeyDirectly(teacher, testId)).rejects.toThrow();
  });

  it('still hands a student every other column of a live question', async () => {
    const id = await insertQuestion(testId, 1, 1);
    await startExam(student, testId);

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string; stem: string }>(
        'select id, number, stem, options, status from public.questions where test_id = $1',
        [testId],
      );
      return res.rows;
    });

    // The exam player still needs the paper. It is only the KEY that is gone.
    expect(rows.map((row) => row.id)).toEqual([id]);
    expect(rows[0].stem).toContain('Council of States');
  });

  // ------------------------------------------------------------------
  // 2. The new route refuses while the exam is open
  // ------------------------------------------------------------------

  it('refuses question_keys() while the caller has an open exam sitting', async () => {
    const id = await insertQuestion(testId, 1, 1);
    await startExam(student, testId);

    await expect(questionKeys(student, [id])).rejects.toThrow();
  });

  it('locks only the test being sat, not the rest of the set', async () => {
    const sat = await insertQuestion(testId, 1, 1);
    const free = await insertQuestion(otherTestId, 1, 2);
    await grantAccess(student);
    await startExam(student, testId);

    await expect(questionKeys(student, [sat])).rejects.toThrow();
    expect(await questionKeys(student, [free])).toEqual(new Map([[free, 2]]));
  });

  it('keeps the lock on after the deadline until the sitting is submitted', async () => {
    const id = await insertQuestion(testId, 1, 1);
    const attempt = await startExam(student, testId);
    await db.admin.query(
      `update public.attempts
         set started_at = now() - interval '2 hours', deadline_at = now() - interval '1 hour'
       where id = $1`,
      [attempt],
    );

    // An un-submitted sitting whose time is up is still open in the sense
    // that matters: the student has not seen a score yet and the paper is
    // still waiting to be marked. Handing the key over now would hand it
    // over for a sitting that is about to be scored.
    await expect(questionKeys(student, [id])).rejects.toThrow();
  });

  it('refuses question_keys() to nobody at all', async () => {
    const id = await insertQuestion(testId, 1, 1);
    await expect(
      db.asAnon((sql) => sql.query('select * from public.question_keys($1::uuid[])', [[id]])),
    ).rejects.toThrow();
  });

  // ------------------------------------------------------------------
  // 3. Submit opens everything back up
  // ------------------------------------------------------------------

  it('hands the key over once score_attempt() has closed the sitting', async () => {
    const id = await insertQuestion(testId, 1, 1);
    const attempt = await startExam(student, testId);

    // The marking itself still reads the key: score_attempt is SECURITY
    // DEFINER and owns the table, so the column privilege is not its gate.
    await db.asUser(student, (sql) =>
      sql.query(
        `insert into public.attempt_answers (attempt_id, question_id, chosen_idx, is_correct)
         values ($1, $2, 1, null)`,
        [attempt, id],
      ),
    );
    expect(await scoreAttempt(student, attempt)).toBe(4);

    expect(await questionKeys(student, [id])).toEqual(new Map([[id, 1]]));
  });

  // ------------------------------------------------------------------
  // 4. Practice, with no exam open, is untouched
  // ------------------------------------------------------------------

  it('lets a student with no open exam start practice and read the key', async () => {
    const id = await insertQuestion(testId, 1, 3);

    await expect(startPractice(student, testId)).resolves.toBeTruthy();
    expect(await questionKeys(student, [id])).toEqual(new Map([[id, 3]]));
  });

  it('never hands over the key of a test the student has not unlocked', async () => {
    await db.admin.query('update public.mock_tests set is_free_sample = false where id = $1', [
      testId,
    ]);
    const id = await insertQuestion(testId, 1, 1);

    // has_test_access() says no, so the key is not theirs even outside an exam.
    expect(await questionKeys(student, [id])).toEqual(new Map());
  });

  it('never hands over the key of a question that is still a draft', async () => {
    const id = await insertQuestion(testId, 1, 1, 'draft');
    expect(await questionKeys(student, [id])).toEqual(new Map());
  });

  // ------------------------------------------------------------------
  // 5 and 6. Teachers
  // ------------------------------------------------------------------

  it('lets a teacher read and change the key of their own question', async () => {
    const id = await insertQuestion(testId, 1, 1, 'draft');

    expect(await questionKeys(teacher, [id])).toEqual(new Map([[id, 1]]));

    const changed = await db.asUser(teacher, (sql) =>
      sql.query('update public.questions set correct_idx = 2 where id = $1', [id]),
    );
    expect(changed.affectedRows ?? 0).toBe(1);
    expect(await questionKeys(teacher, [id])).toEqual(new Map([[id, 2]]));
  });

  it('does not take the key of their own question off a teacher mid-exam', async () => {
    // A teacher trying their own test out is not a student cheating.
    const id = await insertQuestion(testId, 1, 1, 'draft');
    await startExam(teacher, testId);
    expect(await questionKeys(teacher, [id])).toEqual(new Map([[id, 1]]));
  });

  it('refuses another teacher the key and the edit', async () => {
    const id = await insertQuestion(testId, 1, 1, 'draft');

    expect(await questionKeys(other, [id])).toEqual(new Map());

    const changed = await db.asUser(other, (sql) =>
      sql.query('update public.questions set correct_idx = 0 where id = $1', [id]),
    );
    expect(changed.affectedRows ?? 0).toBe(0);

    const stored = await db.admin.query<{ correct_idx: number }>(
      'select correct_idx from public.questions where id = $1',
      [id],
    );
    expect(stored.rows[0].correct_idx).toBe(1);
  });

  // ------------------------------------------------------------------
  // 7. Scenario B: the second tab
  // ------------------------------------------------------------------

  it('refuses a practice sitting while an exam sitting of the same test is open', async () => {
    await startExam(student, testId);
    await expect(startPractice(student, testId)).rejects.toThrow();
  });

  it('allows a practice sitting of a DIFFERENT test while an exam runs', async () => {
    await grantAccess(student);
    await startExam(student, testId);
    await expect(startPractice(student, otherTestId)).resolves.toBeTruthy();
  });

  it('allows practice again once the exam sitting is submitted', async () => {
    const attempt = await startExam(student, testId);
    await expect(startPractice(student, testId)).rejects.toThrow();

    await scoreAttempt(student, attempt);
    await expect(startPractice(student, testId)).resolves.toBeTruthy();
  });

  it('leaves a past-paper practice sitting alone', async () => {
    const paper = await db.admin.query<{ id: string }>(
      `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path, status)
       values ($1, $2, 2024, 'Paper 1 2024', 'papers/p.pdf', 'live')
       returning id`,
      [teacher, CUET],
    );
    await startExam(student, testId);

    await expect(
      db.asUser(student, (sql) =>
        sql.query(
          `insert into public.attempts (user_id, paper_id, test_id, mode)
           values ($1, $2, null, 'practice')`,
          [student, paper.rows[0].id],
        ),
      ),
    ).resolves.toBeTruthy();
  });
});
