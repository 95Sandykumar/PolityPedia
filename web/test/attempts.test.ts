/**
 * Attempts and answers (issue 13-question-player).
 *
 * A student answers a past paper one question at a time. Two tables carry it:
 * `attempts` (one sitting) and `attempt_answers` (one row per question in that
 * sitting, PK `(attempt_id, question_id)`).
 *
 * Design constraint A1: THE UPSERT IS IDEMPOTENT. A phone on a dropping 4G
 * connection sends the same answer twice, and the retry queue in the player
 * sends it again when the network comes back, so the write has to be safe to
 * repeat. The primary key is what makes it safe, so that is what this file
 * proves first, in Postgres, where the guarantee has to live.
 *
 * The rest is privacy. An attempt is a student's score: nobody else reads it,
 * not another student, and not the teacher who owns the paper.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the paper and its questions. */
let teacher: string;
/** The student who sits the paper. Owns the attempt. */
let student: string;
/** A second student. The attacker in the privacy tests. */
let other: string;

let paper: string;
let questionA: string;
let questionB: string;

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

interface AnswerRow {
  question_id: string;
  chosen_idx: number | null;
  is_correct: boolean | null;
  marked: boolean;
}

async function insertQuestion(number: number): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values ($1, $2, $3, 'Which house is the Council of States?', $4::jsonb, 1, true, 'live')
     returning id`,
    [teacher, paper, number, OPTIONS],
  );
  return res.rows[0].id;
}

/** Start an attempt the way the app does: as the student, through RLS. */
function startAttempt(userId: string, mode = 'practice'): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, mode)
       values ($1, $2, $3)
       returning id`,
      [userId, paper, mode],
    );
    return res.rows[0].id;
  });
}

/**
 * The exact write the player's data interface makes: one upsert, conflict on
 * the primary key, so sending it twice rewrites the row instead of adding one.
 */
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

/** Reads with the owner handle, so RLS never hides a row the test asserts on. */
async function storedAnswers(attemptId: string): Promise<AnswerRow[]> {
  const res = await db.admin.query<AnswerRow>(
    `select question_id, chosen_idx, is_correct, marked
     from public.attempt_answers where attempt_id = $1`,
    [attemptId],
  );
  return res.rows;
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

  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Shift 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacher, NET],
  );
  paper = res.rows[0].id;

  questionA = await insertQuestion(1);
  questionB = await insertQuestion(2);
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.attempts');
});

describe('0013_attempts', () => {
  it('is applied as its own migration file', () => {
    expect(db.migrations).toContain('0013_attempts.sql');
  });

  // ------------------------------------------------------------------
  // A1: the upsert is idempotent. The one the issue asks for.
  // ------------------------------------------------------------------
  it('keeps ONE row when the same question is answered twice', async () => {
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, questionA, { chosenIdx: 0, isCorrect: false });
    // The student changes their mind, or the retry queue sends it again.
    await upsertAnswer(student, attempt, questionA, { chosenIdx: 1, isCorrect: true });

    const rows = await storedAnswers(attempt);
    expect(rows).toHaveLength(1);
    expect(rows[0].chosen_idx).toBe(1);
    expect(rows[0].is_correct).toBe(true);
  });

  it('sending the very same answer three times stores it once', async () => {
    const attempt = await startAttempt(student);

    for (let i = 0; i < 3; i += 1) {
      await upsertAnswer(student, attempt, questionA, { chosenIdx: 2, isCorrect: false });
    }

    const rows = await storedAnswers(attempt);
    expect(rows).toHaveLength(1);
    expect(rows[0].chosen_idx).toBe(2);
  });

  it('keeps one row per question, not one per attempt', async () => {
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, questionA, { chosenIdx: 1, isCorrect: true });
    await upsertAnswer(student, attempt, questionB, { chosenIdx: 0, isCorrect: false });

    expect(await storedAnswers(attempt)).toHaveLength(2);
  });

  it('marks a question for later without an answer', async () => {
    const attempt = await startAttempt(student);

    await upsertAnswer(student, attempt, questionA, { marked: true });

    const rows = await storedAnswers(attempt);
    expect(rows).toHaveLength(1);
    expect(rows[0].marked).toBe(true);
    // "Marked but not answered" is a real state: no answer, so no verdict.
    expect(rows[0].chosen_idx).toBeNull();
    expect(rows[0].is_correct).toBeNull();
  });

  // ------------------------------------------------------------------
  // Shape
  // ------------------------------------------------------------------
  it('refuses a chosen option outside 0 to 3', async () => {
    const attempt = await startAttempt(student);
    await expect(
      upsertAnswer(student, attempt, questionA, { chosenIdx: 4 }),
    ).rejects.toThrow();
  });

  it('refuses a mode that is not practice or exam', async () => {
    await expect(
      db.admin.query(
        `insert into public.attempts (user_id, paper_id, mode) values ($1, $2, 'sudden-death')`,
        [student, paper],
      ),
    ).rejects.toThrow();
  });

  it('refuses an attempt with both a paper and a test', async () => {
    await expect(
      db.admin.query(
        `insert into public.attempts (user_id, paper_id, test_id, mode)
         values ($1, $2, gen_random_uuid(), 'practice')`,
        [student, paper],
      ),
    ).rejects.toThrow();
  });

  it('accepts an exam-mode attempt with a deadline', async () => {
    const id = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into public.attempts (user_id, paper_id, mode, deadline_at)
         values ($1, $2, 'exam', now() + interval '3 hours')
         returning id`,
        [student, paper],
      );
      return res.rows[0].id;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ------------------------------------------------------------------
  // RLS: own rows only
  // ------------------------------------------------------------------
  it('a student reads only their own attempts', async () => {
    const mine = await startAttempt(student);
    await startAttempt(other);

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ id: string }>('select id from public.attempts');
      return res.rows;
    });
    expect(rows.map((row) => row.id)).toEqual([mine]);
  });

  it('a student cannot start an attempt in somebody else’s name', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.attempts (user_id, paper_id, mode)
           values ($1, $2, 'practice')`,
          [other, paper],
        );
      }),
    ).rejects.toThrow();
  });

  it('a student cannot write an answer into another student’s attempt', async () => {
    const theirs = await startAttempt(other);

    await expect(
      upsertAnswer(student, theirs, questionA, { chosenIdx: 1, isCorrect: true }),
    ).rejects.toThrow();
  });

  it('a student reads only the answers of their own attempts', async () => {
    const mine = await startAttempt(student);
    const theirs = await startAttempt(other);
    await upsertAnswer(student, mine, questionA, { chosenIdx: 1, isCorrect: true });
    await upsertAnswer(other, theirs, questionB, { chosenIdx: 0, isCorrect: false });

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ question_id: string }>(
        'select question_id from public.attempt_answers',
      );
      return res.rows;
    });
    expect(rows.map((row) => row.question_id)).toEqual([questionA]);
  });

  it('the teacher who owns the paper cannot read a student’s attempt', async () => {
    const mine = await startAttempt(student);
    await upsertAnswer(student, mine, questionA, { chosenIdx: 1, isCorrect: true });

    const rows = await db.asUser(teacher, async (sql) => {
      const res = await sql.query('select id from public.attempts');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('deleting the attempt takes its answers with it', async () => {
    const attempt = await startAttempt(student);
    await upsertAnswer(student, attempt, questionA, { chosenIdx: 1, isCorrect: true });

    await db.asUser(student, async (sql) => {
      await sql.query('delete from public.attempts where id = $1', [attempt]);
    });

    expect(await storedAnswers(attempt)).toHaveLength(0);
  });
});
