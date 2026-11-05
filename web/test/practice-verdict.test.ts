/**
 * Join of issue 30 (answer key locked) and issue 31 (server owns the verdict).
 *
 * 30 took `questions.correct_idx` away from students. 31's trigger marks a
 * practice answer by reading that column. Built apart, together they made every
 * practice answer fail with "permission denied for table questions".
 * 0036 puts the read behind `practice_verdict()`. This file proves:
 *   - practice answers save and are marked again,
 *   - the helper hands over a yes/no only for the caller's own practice sitting,
 *   - it says nothing while an exam sitting of that test is open,
 *   - the key itself is still not readable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;
let teacher: string;
let student: string;
let stranger: string;

const CUET = 'a4000001-0000-4000-8000-000000000002';
const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

let testId: string;
let questionId: string;

beforeAll(async () => {
  db = await createTestDb();
  teacher = await db.createUser();
  student = await db.createUser();
  stranger = await db.createUser();
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
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  const set = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Set 1', 399, 'live') returning id`,
    [teacher, CUET],
  );
  const test = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, 'Test 1', 1, 90, true) returning id`,
    [set.rows[0].id],
  );
  testId = test.rows[0].id;
  const q = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        teacher_explanation, checked, status)
     values ($1, null, $2, 1, 'Which house?', $3::jsonb, 2, 'Article 80.', true, 'live')
     returning id`,
    [teacher, testId, OPTIONS],
  );
  questionId = q.rows[0].id;
});

function startPractice(userId: string): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode)
       values ($1, null, $2, 'practice') returning id`,
      [userId, testId],
    );
    return res.rows[0].id;
  });
}

function verdict(userId: string, attempt: string, chosen: number): Promise<boolean | null> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ v: boolean | null }>(
      'select public.practice_verdict($1::uuid, $2::uuid, $3) as v',
      [attempt, questionId, chosen],
    );
    return res.rows[0].v;
  });
}

describe('0036_practice_verdict_reads_key', () => {
  it('saves a practice answer and marks it right or wrong', async () => {
    const attempt = await startPractice(student);
    const saved = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ is_correct: boolean | null }>(
        `insert into public.attempt_answers (attempt_id, question_id, chosen_idx, is_correct)
         values ($1, $2, 2, false) returning is_correct`,
        [attempt, questionId],
      );
      return res.rows[0].is_correct;
    });
    expect(saved).toBe(true);

    const changed = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ is_correct: boolean | null }>(
        `update public.attempt_answers set chosen_idx = 0 where attempt_id = $1 returning is_correct`,
        [attempt],
      );
      return res.rows[0].is_correct;
    });
    expect(changed).toBe(false);
  });

  it('answers yes or no for the caller s own practice sitting', async () => {
    const attempt = await startPractice(student);
    expect(await verdict(student, attempt, 2)).toBe(true);
    expect(await verdict(student, attempt, 1)).toBe(false);
  });

  it('says nothing for somebody else s sitting', async () => {
    const attempt = await startPractice(student);
    expect(await verdict(stranger, attempt, 2)).toBeNull();
  });

  it('says nothing while an exam sitting of the same test is open', async () => {
    const attempt = await startPractice(student);
    await db.asUser(student, (sql) =>
      sql.query(
        `insert into public.attempts (user_id, paper_id, test_id, mode, deadline_at)
         values ($1, null, $2, 'exam', now() + interval '90 minutes')`,
        [student, testId],
      ),
    );
    expect(await verdict(student, attempt, 2)).toBeNull();
  });

  it('still refuses a direct read of the key', async () => {
    await expect(
      db.asUser(student, (sql) => sql.query('select correct_idx from public.questions')),
    ).rejects.toThrow();
  });
});
