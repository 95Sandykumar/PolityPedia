/**
 * Timed EXAM mode for mock tests, in Postgres (issue 18-exam-mode).
 *
 * The definition of done: "A student starts a test in Exam mode. A timer runs.
 * No answer is shown until they submit. After submit the score is computed on
 * the SERVER and the review shows answers and explanations."
 *
 * Four facts, and every one of them belongs in the database and not in a
 * component, because a component runs on the student's own phone:
 *
 *  1. F-E5, THE ANSWER KEY NEVER REACHES THE PHONE BEFORE SUBMIT. So in exam
 *     mode the browser cannot send a verdict, because it does not have one.
 *     "Answered, not marked yet" has to be a legal row.
 *  2. THE TIMER IS A DEADLINE IN THE DATABASE, not a countdown in JavaScript.
 *     A student who edits the clock, re-opens the tab or replays a held answer
 *     after time is up writes NOTHING: the restrictive policies refuse it.
 *  3. THE SCORE IS COMPUTED ON THE SERVER. `score_attempt()` reads
 *     `questions.correct_idx` itself and marks with the EXAM's scheme (F-E6),
 *     so the number does not depend on anything the phone said.
 *  4. SUBMIT IS SAFE TO CALL TWICE. A retry after a dropped reply must give
 *     the SAME score, never a second (and different) marking run.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the set, its tests and their questions. */
let teacher: string;
/** The student who sits the timed test. */
let student: string;

/** UGC NET: +2 and no negative marking (the 0004 seed). */
const NET = 'a4000001-0000-4000-8000-000000000001';
/** CUET PG: +4 and -1, so negative marking is actually visible in a score. */
const CUET = 'a4000001-0000-4000-8000-000000000002';
/** PGT: no published scheme at all, so the fallback has to hold. */
const PGT = 'a4000001-0000-4000-8000-000000000003';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

let setId: string;
/** Test 1, the free sample: open to everybody, so no grant is in the way. */
let testId: string;

async function insertSet(examId: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, 'live')
     returning id`,
    [teacher, examId],
  );
  return res.rows[0].id;
}

async function insertTest(durationMin = 90): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, 'Test 1', 1, $2, true)
     returning id`,
    [setId, durationMin],
  );
  return res.rows[0].id;
}

/** One LIVE, CHECKED question whose right answer is `correctIdx`. */
async function insertQuestion(number: number, correctIdx: number): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        teacher_explanation, checked, status)
     values ($1, null, $2, $3, 'Which house is the Council of States?',
             $4::jsonb, $5, 'Article 80 names it.', true, 'live')
     returning id`,
    [teacher, testId, number, OPTIONS, correctIdx],
  );
  return res.rows[0].id;
}

/**
 * The exact insert the load route makes: a timed sitting whose deadline is
 * `now + duration`.
 */
function startExam(userId: string, minutes = 90): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode, deadline_at)
       values ($1, null, $2, 'exam', now() + ($3 || ' minutes')::interval)
       returning id`,
      [userId, testId, String(minutes)],
    );
    return res.rows[0].id;
  });
}

/**
 * Move an open sitting's clock into the past, which is what a student who
 * closed the tab and came back an hour later walks into.
 *
 * `started_at` goes back with it, because `attempts_deadline_check` in 0013
 * refuses a deadline before the start: a sitting whose time is up is one that
 * STARTED long enough ago, never one that was born already over.
 */
async function runOutOfTime(attemptId: string): Promise<void> {
  await db.admin.query(
    `update public.attempts
       set started_at  = now() - interval '2 hours',
           deadline_at = now() - interval '1 hour'
     where id = $1`,
    [attemptId],
  );
}

/**
 * The write the EXAM player makes: a chosen option and NO verdict, because the
 * phone was never given the key (F-E5).
 */
function answer(
  userId: string,
  attemptId: string,
  questionId: string,
  values: { chosenIdx?: number | null; marked?: boolean } = {},
): Promise<void> {
  return db.asUser(userId, async (sql) => {
    await sql.query(
      `insert into public.attempt_answers
         (attempt_id, question_id, chosen_idx, is_correct, marked)
       values ($1, $2, $3, null, $4)
       on conflict (attempt_id, question_id) do update
         set chosen_idx  = excluded.chosen_idx,
             marked      = excluded.marked,
             answered_at = now()`,
      [attemptId, questionId, values.chosenIdx ?? null, values.marked ?? false],
    );
  });
}

/** `score_attempt()`, called the way our own route calls it. */
function scoreAttempt(userId: string, attemptId: string): Promise<number | null> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ score: number | null }>(
      'select public.score_attempt($1::uuid) as score',
      [attemptId],
    );
    return res.rows[0].score;
  });
}

/** Read with the owner handle, so RLS never hides a row the test asserts on. */
async function storedAttempt(
  attemptId: string,
): Promise<{ submitted_at: Date | null; score: number | null }> {
  const res = await db.admin.query<{ submitted_at: Date | null; score: number | null }>(
    'select submitted_at, score from public.attempts where id = $1',
    [attemptId],
  );
  return res.rows[0];
}

async function storedVerdicts(attemptId: string): Promise<(boolean | null)[]> {
  const res = await db.admin.query<{ is_correct: boolean | null }>(
    `select is_correct from public.attempt_answers
     where attempt_id = $1 order by answered_at asc, question_id asc`,
    [attemptId],
  );
  return res.rows.map((row) => row.is_correct);
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

  setId = await insertSet(CUET);
  testId = await insertTest();
});

describe('the migration', () => {
  it('is applied in number order, after the practice mode it grows from', async () => {
    expect(db.migrations).toContain('0018_exam_mode.sql');
    expect(db.migrations.indexOf('0018_exam_mode.sql')).toBeGreaterThan(
      db.migrations.indexOf('0017_practice_mode.sql'),
    );
  });
});

// --------------------------------------------------------------------------
// 1. "Answered, not marked yet" is a real row (F-E5)
// --------------------------------------------------------------------------
describe('an answer with no verdict', () => {
  it('is stored, because in exam mode the phone has no answer key', async () => {
    const question = await insertQuestion(1, 1);
    const attempt = await startExam(student);

    await answer(student, attempt, question, { chosenIdx: 2 });

    expect(await storedVerdicts(attempt)).toEqual([null]);
  });

  it('still refuses a verdict with no chosen option, which is a bug upstream', async () => {
    const question = await insertQuestion(1, 1);
    const attempt = await startExam(student);

    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.attempt_answers
             (attempt_id, question_id, chosen_idx, is_correct)
           values ($1, $2, null, true)`,
          [attempt, question],
        );
      }),
    ).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// 2. The timer is a deadline in the database
// --------------------------------------------------------------------------
describe('the deadline', () => {
  it('lets an answer through while there is time left', async () => {
    const question = await insertQuestion(1, 1);
    const attempt = await startExam(student, 90);

    await answer(student, attempt, question, { chosenIdx: 1 });

    expect(await storedVerdicts(attempt)).toHaveLength(1);
  });

  it('refuses a new answer once the time is up', async () => {
    const question = await insertQuestion(1, 1);
    const attempt = await startExam(student, 90);
    await runOutOfTime(attempt);

    await expect(answer(student, attempt, question, { chosenIdx: 1 })).rejects.toThrow();
    expect(await storedVerdicts(attempt)).toHaveLength(0);
  });

  it('refuses a CHANGE to an answer once the time is up', async () => {
    const question = await insertQuestion(1, 1);
    const attempt = await startExam(student, 90);
    await answer(student, attempt, question, { chosenIdx: 0 });

    // The clock runs out mid-sitting.
    await runOutOfTime(attempt);

    await expect(answer(student, attempt, question, { chosenIdx: 3 })).rejects.toThrow();

    const res = await db.admin.query<{ chosen_idx: number }>(
      'select chosen_idx from public.attempt_answers where attempt_id = $1',
      [attempt],
    );
    expect(res.rows[0].chosen_idx).toBe(0);
  });

  it('refuses an answer once the sitting has been submitted', async () => {
    const question = await insertQuestion(1, 1);
    const second = await insertQuestion(2, 0);
    const attempt = await startExam(student, 90);
    await answer(student, attempt, question, { chosenIdx: 1 });
    await scoreAttempt(student, attempt);

    await expect(answer(student, attempt, second, { chosenIdx: 1 })).rejects.toThrow();
  });

  it('leaves PRACTICE alone, because practice has no timer at all', async () => {
    const question = await insertQuestion(1, 1);
    const attempt = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into public.attempts (user_id, paper_id, test_id, mode)
         values ($1, null, $2, 'practice') returning id`,
        [student, testId],
      );
      return res.rows[0].id;
    });

    await db.asUser(student, async (sql) => {
      await sql.query(
        `insert into public.attempt_answers
           (attempt_id, question_id, chosen_idx, is_correct)
         values ($1, $2, 1, true)`,
        [attempt, question],
      );
    });

    expect(await storedVerdicts(attempt)).toEqual([true]);
  });
});

// --------------------------------------------------------------------------
// 3. The score is computed on the server, with the exam's marking (F-E6)
// --------------------------------------------------------------------------
describe('score_attempt', () => {
  it('marks +4 and -1 from the exam, not a count of right answers', async () => {
    // 3 right at +4 and 2 wrong at -1 is 10, never 3.
    const right = [
      await insertQuestion(1, 0),
      await insertQuestion(2, 1),
      await insertQuestion(3, 2),
    ];
    const wrong = [await insertQuestion(4, 3), await insertQuestion(5, 3)];
    const attempt = await startExam(student);

    await answer(student, attempt, right[0], { chosenIdx: 0 });
    await answer(student, attempt, right[1], { chosenIdx: 1 });
    await answer(student, attempt, right[2], { chosenIdx: 2 });
    await answer(student, attempt, wrong[0], { chosenIdx: 0 });
    await answer(student, attempt, wrong[1], { chosenIdx: 1 });

    expect(await scoreAttempt(student, attempt)).toBe(10);
    expect((await storedAttempt(attempt)).score).toBe(10);
  });

  it('writes the verdict itself, from correct_idx the phone never saw', async () => {
    const first = await insertQuestion(1, 2);
    const second = await insertQuestion(2, 3);
    const attempt = await startExam(student);

    await answer(student, attempt, first, { chosenIdx: 2 });
    await answer(student, attempt, second, { chosenIdx: 0 });

    await scoreAttempt(student, attempt);

    expect(await storedVerdicts(attempt)).toEqual([true, false]);
  });

  it('scores an unattempted question at nothing, never as a wrong answer', async () => {
    const answered = await insertQuestion(1, 0);
    const skipped = await insertQuestion(2, 0);
    const attempt = await startExam(student);

    await answer(student, attempt, answered, { chosenIdx: 0 });
    // Marked for later and left blank: no chosen option, so no penalty.
    await answer(student, attempt, skipped, { chosenIdx: null, marked: true });

    expect(await scoreAttempt(student, attempt)).toBe(4);
  });

  it('closes the sitting, which is what puts the tick on the mock list', async () => {
    const question = await insertQuestion(1, 0);
    const attempt = await startExam(student);
    await answer(student, attempt, question, { chosenIdx: 0 });

    expect((await storedAttempt(attempt)).submitted_at).toBeNull();
    await scoreAttempt(student, attempt);
    expect((await storedAttempt(attempt)).submitted_at).not.toBeNull();
  });

  it('gives the SAME score when it is called twice', async () => {
    const question = await insertQuestion(1, 0);
    const attempt = await startExam(student);
    await answer(student, attempt, question, { chosenIdx: 0 });

    const first = await scoreAttempt(student, attempt);
    const second = await scoreAttempt(student, attempt);

    expect(first).toBe(4);
    expect(second).toBe(4);
    expect((await storedAttempt(attempt)).score).toBe(4);
  });

  it('does not re-mark on the second call, so a late fix cannot move a score', async () => {
    const question = await insertQuestion(1, 0);
    const attempt = await startExam(student);
    await answer(student, attempt, question, { chosenIdx: 0 });
    await scoreAttempt(student, attempt);

    // The teacher fixes the key AFTER the student has seen 4 out of 4.
    await db.admin.query('update public.questions set correct_idx = 3 where id = $1', [
      question,
    ]);

    expect(await scoreAttempt(student, attempt)).toBe(4);
  });

  it('can run out a sitting whose time is up, which is the auto-submit', async () => {
    const question = await insertQuestion(1, 0);
    const attempt = await startExam(student, 90);
    await answer(student, attempt, question, { chosenIdx: 0 });
    await runOutOfTime(attempt);

    expect(await scoreAttempt(student, attempt)).toBe(4);
  });

  it('scores zero for a sitting with nothing answered at all', async () => {
    await insertQuestion(1, 0);
    const attempt = await startExam(student);

    expect(await scoreAttempt(student, attempt)).toBe(0);
    expect((await storedAttempt(attempt)).score).toBe(0);
  });

  it('refuses a sitting that belongs to somebody else', async () => {
    const question = await insertQuestion(1, 0);
    const attempt = await startExam(student);
    await answer(student, attempt, question, { chosenIdx: 0 });

    const other = await db.createUser();
    await expect(scoreAttempt(other, attempt)).rejects.toThrow();
    expect((await storedAttempt(attempt)).submitted_at).toBeNull();
  });

  it('refuses a sitting that does not exist', async () => {
    await expect(
      scoreAttempt(student, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow();
  });
});

describe('score_attempt and the marking fallback', () => {
  it('uses +2 and no penalty for UGC NET', async () => {
    setId = await insertSet(NET);
    testId = await insertTest();
    const right = await insertQuestion(1, 0);
    const wrong = await insertQuestion(2, 0);
    const attempt = await startExam(student);

    await answer(student, attempt, right, { chosenIdx: 0 });
    await answer(student, attempt, wrong, { chosenIdx: 1 });

    // 1 right at +2 and 1 wrong at 0 is 2.
    expect(await scoreAttempt(student, attempt)).toBe(2);
  });

  it('falls back to one mark a question when the exam has no scheme', async () => {
    setId = await insertSet(PGT);
    testId = await insertTest();
    const right = await insertQuestion(1, 0);
    const wrong = await insertQuestion(2, 0);
    const attempt = await startExam(student);

    await answer(student, attempt, right, { chosenIdx: 0 });
    await answer(student, attempt, wrong, { chosenIdx: 1 });

    // A 0 out of 0 for a paper they got right would be the alternative.
    expect(await scoreAttempt(student, attempt)).toBe(1);
  });

  it('works for a PAST PAPER too, which has a test id of null', async () => {
    const paper = await db.admin.query<{ id: string }>(
      `insert into public.papers
         (teacher_id, exam_id, year, label, pdf_questions_path, status)
       values ($1, $2, 2024, 'CUET PG 2024', 'papers/q.pdf', 'live')
       returning id`,
      [teacher, CUET],
    );
    const paperId = paper.rows[0].id;
    const question = await db.admin.query<{ id: string }>(
      `insert into public.questions
         (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
       values ($1, $2, 1, 'Which house?', $3::jsonb, 0, true, 'live')
       returning id`,
      [teacher, paperId, OPTIONS],
    );

    const attempt = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into public.attempts (user_id, paper_id, mode, deadline_at)
         values ($1, $2, 'exam', now() + interval '90 minutes') returning id`,
        [student, paperId],
      );
      return res.rows[0].id;
    });

    await answer(student, attempt, question.rows[0].id, { chosenIdx: 0 });

    expect(await scoreAttempt(student, attempt)).toBe(4);
  });
});
