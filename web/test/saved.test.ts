/**
 * The Saved list: Wrong and Marked (issue 14-saved-list).
 *
 * PRD F-E8: ONE saved list with TWO tags. So there is one table and the tag is
 * a column, not two tables and not two booleans on `questions`.
 *
 * Three things this file proves, in Postgres, where the guarantees have to live:
 *
 *  1. THE KEY MAKES THE SAVE IDEMPOTENT. `(user_id, question_id, tag)` plus
 *     `on conflict do nothing` is the exact write the app makes, so a wrong
 *     answer tapped twice (or re-sent after a dropped connection) leaves ONE
 *     `wrong` row, never two. Same reasoning as A1 in `0013_attempts.sql`.
 *  2. BOTH TAGS FIT ON ONE QUESTION. `tag` is in the key, so a question a
 *     student got wrong AND marked carries both rows and shows under both
 *     chips.
 *  3. PRIVACY. A saved question says what a student got wrong, so nobody else
 *     reads it: not another student, and not the teacher who wrote the
 *     question.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the paper and its questions. */
let teacher: string;
/** The student who saves. Owns every row below. */
let student: string;
/** A second student. The attacker in the privacy tests. */
let other: string;

let paper: string;
let questionA: string;
let questionB: string;

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

interface SavedRow {
  user_id: string;
  question_id: string;
  tag: string;
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

/**
 * The exact write the app makes: one insert, conflict on the primary key, so
 * sending the same save twice keeps one row instead of failing.
 */
function save(userId: string, questionId: string, tag: string): Promise<void> {
  return db.asUser(userId, async (sql) => {
    await sql.query(
      `insert into public.saved_questions (user_id, question_id, tag)
       values ($1, $2, $3)
       on conflict (user_id, question_id, tag) do nothing`,
      [userId, questionId, tag],
    );
  });
}

/** Reads with the owner handle, so RLS never hides a row the test asserts on. */
async function stored(userId: string): Promise<SavedRow[]> {
  const res = await db.admin.query<SavedRow>(
    `select user_id, question_id, tag from public.saved_questions
     where user_id = $1 order by tag`,
    [userId],
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
  await db.admin.query('delete from public.saved_questions');
});

describe('0014_saved', () => {
  it('is applied as its own migration file', () => {
    expect(db.migrations).toContain('0014_saved.sql');
  });

  it('has row level security on', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.saved_questions'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('keys a row on user, question AND tag', async () => {
    const res = await db.admin.query<{ attname: string }>(
      `select a.attname
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
       where i.indrelid = 'public.saved_questions'::regclass and i.indisprimary
       order by a.attname`,
    );
    expect(res.rows.map((row) => row.attname)).toEqual(['question_id', 'tag', 'user_id']);
  });

  it('refuses a tag that is not wrong or marked', async () => {
    await expect(save(student, questionA, 'later')).rejects.toThrow();
  });
});

describe('a wrong answer saves itself once', () => {
  it('stores exactly one wrong row, however many times it is sent', async () => {
    await save(student, questionA, 'wrong');
    await save(student, questionA, 'wrong');
    await save(student, questionA, 'wrong');

    const rows = await stored(student);
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).toBe('wrong');
    expect(rows[0].question_id).toBe(questionA);
  });

  it('lets one question carry both tags, because the tag is in the key', async () => {
    await save(student, questionA, 'wrong');
    await save(student, questionA, 'marked');

    expect((await stored(student)).map((row) => row.tag)).toEqual(['marked', 'wrong']);
  });
});

describe('Mark for later', () => {
  it('stores a marked row the student can read back', async () => {
    await save(student, questionB, 'marked');

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<SavedRow>(
        'select user_id, question_id, tag from public.saved_questions',
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question_id: questionB, tag: 'marked' });
  });

  it('is removed by the student who saved it', async () => {
    await save(student, questionB, 'marked');

    await db.asUser(student, async (sql) => {
      await sql.query(
        'delete from public.saved_questions where question_id = $1 and tag = $2',
        [questionB, 'marked'],
      );
    });

    expect(await stored(student)).toHaveLength(0);
  });
});

describe('privacy: own rows only', () => {
  it('user B cannot read user A rows', async () => {
    await save(student, questionA, 'wrong');

    const rows = await db.asUser(other, async (sql) => {
      const res = await sql.query('select * from public.saved_questions');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('user B cannot delete user A rows', async () => {
    await save(student, questionA, 'wrong');

    await db.asUser(other, async (sql) => {
      await sql.query('delete from public.saved_questions');
    });

    // Still there: the delete matched no row it was allowed to see.
    expect(await stored(student)).toHaveLength(1);
  });

  it('refuses a row saved for somebody else', async () => {
    await expect(
      db.asUser(other, async (sql) => {
        await sql.query(
          'insert into public.saved_questions (user_id, question_id, tag) values ($1, $2, $3)',
          [student, questionA, 'wrong'],
        );
      }),
    ).rejects.toThrow();
  });

  it('hides the rows from a visitor who is not signed in', async () => {
    await save(student, questionA, 'wrong');

    const rows = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.saved_questions');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('is not readable by the teacher who wrote the question', async () => {
    await save(student, questionA, 'wrong');

    const rows = await db.asUser(teacher, async (sql) => {
      const res = await sql.query('select * from public.saved_questions');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe('cleanup', () => {
  it('drops the saved row when the question goes away', async () => {
    await save(student, questionB, 'marked');
    await db.admin.query('delete from public.questions where id = $1', [questionB]);

    expect(await stored(student)).toHaveLength(0);

    // Put it back, so the order of the tests above cannot matter.
    questionB = await insertQuestion(2);
  });
});
