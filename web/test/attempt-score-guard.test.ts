/**
 * A student must not be able to write their own score or deadline
 * (issue 31-attempt-score-guard, security fix from the 2026-11-05 review).
 *
 * THE HOLE THIS FILE CLOSES. `attempts_update_own` in `0013_attempts.sql` only
 * asks "is this your row?". It cannot see the OLD row, so it cannot tell a
 * submit from a forgery, and there was no trigger behind it. A student could
 * therefore send one REST call and
 *
 *   * set `score` to 999, which the batch report (issue 20) then shows a
 *     teacher as a real mark,
 *   * set `submitted_at` back to null and re-open a closed exam,
 *   * move `deadline_at` to the year 2100 and sit a timed paper for ever,
 *   * claim `is_correct` on an answer that is wrong.
 *
 * THE RULE AFTER THIS SLICE: the SERVER owns the verdict, the score, the
 * deadline and the close. `score_attempt()` (0018) is the only thing that
 * writes `attempts.score` and `attempts.submitted_at`, the exam deadline is
 * worked out from `mock_tests.duration_min` inside Postgres, and a practice
 * verdict is recomputed from `questions.correct_idx` on the way in.
 *
 * Seed with `db.admin` (bypasses RLS), write with `db.asUser` (Postgres
 * evaluates every policy and every trigger for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the set, its tests and their questions. */
let teacher: string;
/** The student whose score this is. */
let student: string;
/** Somebody else, who must not be able to touch it. */
let other: string;

/** CUET PG, from the 0004 seed: +4 and -1, so marking shows in a score. */
const CUET = 'a4000001-0000-4000-8000-000000000002';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

let setId: string;
/** Test 1, the free sample, 90 minutes long. */
let testId: string;
/** A past paper, for the sittings that have no mock test at all. */
let paperId: string;

const MINUTE = 60_000;

async function insertSet(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, 'live')
     returning id`,
    [teacher, CUET],
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

async function insertPaper(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'CUET PG 2024 Shift 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacher, CUET],
  );
  return res.rows[0].id;
}

/** One LIVE, CHECKED question on the mock test. `correct_idx` is always 1. */
async function insertQuestion(number: number): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        checked, status)
     values ($1, null, $2, $3, 'Which house is the Council of States?',
             $4::jsonb, 1, true, 'live')
     returning id`,
    [teacher, testId, number, OPTIONS],
  );
  return res.rows[0].id;
}

/** Start a sitting the way the app does: as the student, through RLS. */
function startAttempt(
  userId: string,
  values: { mode?: string; onPaper?: boolean; deadlineAt?: string | null } = {},
): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode, deadline_at)
       values ($1, $2, $3, $4, $5::timestamptz)
       returning id`,
      [
        userId,
        values.onPaper ? paperId : null,
        values.onPaper ? null : testId,
        values.mode ?? 'practice',
        values.deadlineAt ?? null,
      ],
    );
    return res.rows[0].id;
  });
}

/** The player's upsert, with whatever verdict the caller claims (A1). */
function upsertAnswer(
  userId: string,
  attemptId: string,
  questionId: string,
  values: { chosenIdx?: number | null; isCorrect?: boolean | null; marked?: boolean } = {},
): Promise<void> {
  return db.asUser(userId, async (sql) => {
    await sql.query(
      `insert into public.attempt_answers
         (attempt_id, question_id, chosen_idx, is_correct, marked)
       values ($1, $2, $3, $4, $5)
       on conflict (attempt_id, question_id) do update
         set chosen_idx  = excluded.chosen_idx,
             is_correct  = excluded.is_correct,
             marked      = excluded.marked,
             answered_at = now()`,
      [
        attemptId,
        questionId,
        values.chosenIdx ?? null,
        values.isCorrect ?? null,
        values.marked ?? false,
      ],
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

/** One PATCH of one column, as the student. Returns the rows it moved. */
function patch(
  userId: string,
  attemptId: string,
  sqlSet: string,
  params: unknown[] = [],
): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query(
      `update public.attempts set ${sqlSet} where id = $1`,
      [attemptId, ...params],
    );
    return res.affectedRows ?? 0;
  });
}

interface StoredAttempt {
  user_id: string;
  test_id: string | null;
  paper_id: string | null;
  mode: string;
  topic_id: string | null;
  deadline_at: Date | null;
  submitted_at: Date | null;
  score: number | null;
}

/** Reads with the owner handle, so RLS never hides a row the test asserts on. */
async function stored(attemptId: string): Promise<StoredAttempt> {
  const res = await db.admin.query<StoredAttempt>(
    `select user_id, test_id, paper_id, mode, topic_id, deadline_at, submitted_at, score
     from public.attempts where id = $1`,
    [attemptId],
  );
  return res.rows[0];
}

async function storedVerdicts(attemptId: string): Promise<(boolean | null)[]> {
  const res = await db.admin.query<{ is_correct: boolean | null }>(
    `select is_correct from public.attempt_answers
     where attempt_id = $1 order by question_id`,
    [attemptId],
  );
  return res.rows.map((one) => one.is_correct);
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();
  other = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacher],
  );
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.papers');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  setId = await insertSet();
  testId = await insertTest(90);
  paperId = await insertPaper();
});

describe('the migration', () => {
  it('is applied after the attempts tables and the server marking it leans on', async () => {
    expect(db.migrations).toContain('0031_attempt_score_guard.sql');
    expect(db.migrations.indexOf('0031_attempt_score_guard.sql')).toBeGreaterThan(
      db.migrations.indexOf('0018_exam_mode.sql'),
    );
  });
});

// --------------------------------------------------------------------------
// 1. A student cannot write their own score
// --------------------------------------------------------------------------
describe('attempts.score', () => {
  it('cannot be raised by the student it belongs to', async () => {
    const attempt = await startAttempt(student);

    await expect(patch(student, attempt, 'score = 999')).rejects.toThrow();
    expect((await stored(attempt)).score).toBeNull();
  });

  it('cannot be raised after the server has marked the sitting', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);
    await upsertAnswer(student, attempt, question, { chosenIdx: 1, isCorrect: true });
    expect(await scoreAttempt(student, attempt)).toBe(4);

    await expect(patch(student, attempt, 'score = 999')).rejects.toThrow();
    expect((await stored(attempt)).score).toBe(4);
  });

  it('cannot be chosen on the way in either', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.attempts (user_id, test_id, mode, score)
           values ($1, $2, 'practice', 999)`,
          [student, testId],
        );
      }),
    ).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// 2. A student cannot re-open a closed sitting
// --------------------------------------------------------------------------
describe('attempts.submitted_at', () => {
  it('cannot be set back to null on a submitted sitting', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);
    await upsertAnswer(student, attempt, question, { chosenIdx: 1, isCorrect: true });
    await scoreAttempt(student, attempt);

    await expect(patch(student, attempt, 'submitted_at = null')).rejects.toThrow();
    expect((await stored(attempt)).submitted_at).not.toBeNull();
  });

  it('cannot be written by hand to close a sitting the server never marked', async () => {
    const attempt = await startAttempt(student);

    await expect(patch(student, attempt, 'submitted_at = now()')).rejects.toThrow();
    expect((await stored(attempt)).submitted_at).toBeNull();
  });

  it('cannot be chosen on the way in', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.attempts (user_id, test_id, mode, submitted_at)
           values ($1, $2, 'practice', now())`,
          [student, testId],
        );
      }),
    ).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// 3. The exam deadline comes from the server
// --------------------------------------------------------------------------
describe('attempts.deadline_at', () => {
  it('cannot be moved once the sitting has started', async () => {
    const attempt = await startAttempt(student, { mode: 'exam' });
    const before = (await stored(attempt)).deadline_at;

    await expect(
      patch(student, attempt, 'deadline_at = $2::timestamptz', ['2100-01-01T00:00:00Z']),
    ).rejects.toThrow();
    expect((await stored(attempt)).deadline_at).toEqual(before);
  });

  it('is the test s own duration, not the one the caller sent', async () => {
    const attempt = await startAttempt(student, {
      mode: 'exam',
      deadlineAt: '2100-01-01T00:00:00Z',
    });

    const deadline = (await stored(attempt)).deadline_at;
    expect(deadline).not.toBeNull();
    const minutes = ((deadline as Date).getTime() - Date.now()) / MINUTE;
    // 90 minutes, which is `mock_tests.duration_min`, and nowhere near 2100.
    expect(minutes).toBeGreaterThan(80);
    expect(minutes).toBeLessThan(95);
  });

  it('is still refused outright in practice mode, which has no timer', async () => {
    await expect(
      startAttempt(student, {
        mode: 'practice',
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// 4. The parent and the owner of a sitting are fixed
// --------------------------------------------------------------------------
describe('the rest of the forgeable columns', () => {
  it('refuses a change of mode, which would drop an exam s clock', async () => {
    const attempt = await startAttempt(student, { mode: 'exam' });
    await expect(patch(student, attempt, `mode = 'practice'`)).rejects.toThrow();
  });

  it('refuses a change of test_id, which would move a score to another test', async () => {
    const attempt = await startAttempt(student);
    const second = await db.admin.query<{ id: string }>(
      `insert into public.mock_tests (set_id, title, position, duration_min)
       values ($1, 'Test 2', 2, 60) returning id`,
      [setId],
    );

    await expect(
      patch(student, attempt, 'test_id = $2::uuid', [second.rows[0].id]),
    ).rejects.toThrow();
  });

  it('refuses a change of user_id, which would hand the sitting to somebody else', async () => {
    const attempt = await startAttempt(student);
    await expect(patch(student, attempt, 'user_id = $2::uuid', [other])).rejects.toThrow();
  });

  it('still lets the student change a harmless column the app owns', async () => {
    const attempt = await startAttempt(student);
    const topic = 'c0000001-0000-4000-8000-00000000000a';

    expect(await patch(student, attempt, 'topic_id = $2::uuid', [topic])).toBe(1);
    expect((await stored(attempt)).topic_id).toBe(topic);
  });

  it('leaves another student s sitting completely alone', async () => {
    const mine = await startAttempt(student);

    // RLS hides the row, so the PATCH moves nothing and raises nothing.
    expect(await patch(other, mine, 'topic_id = null')).toBe(0);
    await expect(patch(other, mine, 'score = 999')).resolves.toBe(0);
    expect((await stored(mine)).score).toBeNull();
  });
});

// --------------------------------------------------------------------------
// 5. The verdict on an answer is the server's too
// --------------------------------------------------------------------------
describe('attempt_answers.is_correct', () => {
  it('is recomputed from the key when a practice answer claims a wrong verdict', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);

    // `correct_idx` is 1, so option 0 is wrong however loudly the phone says so.
    await upsertAnswer(student, attempt, question, { chosenIdx: 0, isCorrect: true });

    expect(await storedVerdicts(attempt)).toEqual([false]);
  });

  it('still stores a right practice answer as right, so the player keeps working', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, question, { chosenIdx: 1, isCorrect: true });

    expect(await storedVerdicts(attempt)).toEqual([true]);
  });

  it('is corrected again when the student changes their mind', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, question, { chosenIdx: 1, isCorrect: true });
    await upsertAnswer(student, attempt, question, { chosenIdx: 3, isCorrect: true });

    expect(await storedVerdicts(attempt)).toEqual([false]);
  });

  it('stays null on a question that is only marked for later', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, question, { marked: true });

    expect(await storedVerdicts(attempt)).toEqual([null]);
  });

  it('is REFUSED in exam mode, where the phone was never given the key', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student, { mode: 'exam' });

    await expect(
      upsertAnswer(student, attempt, question, { chosenIdx: 1, isCorrect: true }),
    ).rejects.toThrow();
    expect(await storedVerdicts(attempt)).toEqual([]);
  });

  it('is still written by score_attempt(), which is what marks an exam', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student, { mode: 'exam' });
    await upsertAnswer(student, attempt, question, { chosenIdx: 1 });

    expect(await scoreAttempt(student, attempt)).toBe(4);
    expect(await storedVerdicts(attempt)).toEqual([true]);
  });
});

// --------------------------------------------------------------------------
// 6. The whole practice sitting, end to end, still works
// --------------------------------------------------------------------------
describe('a practice sitting, start to score', () => {
  it('saves answers, marks them, and closes on the server s number', async () => {
    const right = await insertQuestion(1);
    const wrong = await insertQuestion(2);
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, right, { chosenIdx: 1, isCorrect: true });
    await upsertAnswer(student, attempt, wrong, { chosenIdx: 0, isCorrect: false });

    // CUET PG: one right at +4 and one wrong at -1 is 3.
    expect(await scoreAttempt(student, attempt)).toBe(3);

    const row = await stored(attempt);
    expect(row.score).toBe(3);
    expect(row.submitted_at).not.toBeNull();
  });

  it('is safe to submit twice, and the second call cannot move the score', async () => {
    const question = await insertQuestion(1);
    const attempt = await startAttempt(student);
    await upsertAnswer(student, attempt, question, { chosenIdx: 1, isCorrect: true });

    expect(await scoreAttempt(student, attempt)).toBe(4);
    expect(await scoreAttempt(student, attempt)).toBe(4);
  });

  it('keeps working for a past paper, which has no mock test at all', async () => {
    const res = await db.admin.query<{ id: string }>(
      `insert into public.questions
         (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
       values ($1, $2, 1, 'Which house?', $3::jsonb, 1, true, 'live')
       returning id`,
      [teacher, paperId, OPTIONS],
    );
    const attempt = await startAttempt(student, { onPaper: true });

    await upsertAnswer(student, attempt, res.rows[0].id, { chosenIdx: 1, isCorrect: true });

    expect(await scoreAttempt(student, attempt)).toBe(4);
  });

  it('refuses another student s submit, so a score is never marked by a stranger', async () => {
    const attempt = await startAttempt(student);
    await expect(scoreAttempt(other, attempt)).rejects.toThrow();
  });
});
