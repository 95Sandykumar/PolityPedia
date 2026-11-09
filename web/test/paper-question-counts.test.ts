/**
 * `paper_question_counts`, the per-paper live question count (issue
 * 81-fix-papers-count-truncation).
 *
 * WHY THIS VIEW EXISTS. The papers list used to fetch every live question row
 * and count them in JavaScript. PostgREST caps a response (1000 rows by
 * default) and a paper holds up to 200 questions, so a teacher with about six
 * full papers lost rows off the end of the list. The last papers then showed
 * "0 questions" and the page hid Practice on a paper that has questions.
 *
 * The count is now made by Postgres, one row per paper, so the response is as
 * long as the paper list and the cap can never reach it.
 *
 * SAME ROW RULES AS BEFORE. The view is `security_invoker = true`, so
 * `questions_select_live` still decides which rows are counted: a student only
 * ever counts LIVE questions of an APPROVED teacher.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the six full papers below. */
let teacherA: string;
/** A teacher who is NOT approved. Their live rows must stay uncounted. */
let pending: string;
/** A plain student: the person the papers list is drawn for. */
let student: string;

/** Six papers of 200 live questions each: 1200 rows, past the 1000 cap. */
let fullPapers: string[] = [];
/** A live paper with no question at all. */
let emptyPaper = '';
/** A paper whose questions are all still drafts. */
let draftPaper = '';
/** The unapproved teacher's paper, with live questions on it. */
let hiddenPaper = '';

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

/** 200 questions is the per-paper ceiling (`questions_number_check`). */
const FULL = 200;
const FULL_PAPERS = 6;

async function insertPaper(teacherId: string, label: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, $3, 'papers/q.pdf', 'live')
     returning id`,
    [teacherId, NET, label],
  );
  return res.rows[0].id;
}

/** `count` questions on one paper, in one statement, all with the same status. */
async function insertQuestions(
  teacherId: string,
  paperId: string,
  count: number,
  status: 'draft' | 'live',
): Promise<void> {
  await db.admin.query(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     select $1, $2, n, 'Question ' || n, $3::jsonb, 1, true, $4
     from generate_series(1, $5::int) as n`,
    [teacherId, paperId, OPTIONS, status, count],
  );
}

/** The view as the student reads it: paper id -> counted questions. */
function countsFor(userId: string, paperIds: readonly string[]): Promise<Map<string, number>> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ paper_id: string; question_count: number }>(
      `select paper_id, question_count
       from public.paper_question_counts
       where paper_id = any($1::uuid[])`,
      [paperIds as string[]],
    );
    return new Map(res.rows.map((row) => [row.paper_id, Number(row.question_count)]));
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  pending = await db.createUser();
  student = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacherA],
  );
  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Waiting Guru', 'pending')`,
    [pending],
  );

  fullPapers = [];
  for (let i = 0; i < FULL_PAPERS; i += 1) {
    const paper = await insertPaper(teacherA, `Full paper ${i + 1}`);
    await insertQuestions(teacherA, paper, FULL, 'live');
    fullPapers.push(paper);
  }

  emptyPaper = await insertPaper(teacherA, 'Empty paper');

  draftPaper = await insertPaper(teacherA, 'Draft paper');
  await insertQuestions(teacherA, draftPaper, 5, 'draft');

  hiddenPaper = await insertPaper(pending, 'Not approved yet');
  await insertQuestions(pending, hiddenPaper, 7, 'live');
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('0056_paper_question_counts.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0056_paper_question_counts.sql');
  });

  it('seeded more live question rows than a PostgREST page holds', async () => {
    const res = await db.admin.query<{ n: number }>(
      `select count(*)::int as n from public.questions where status = 'live'`,
    );
    expect(Number(res.rows[0].n)).toBeGreaterThan(1000);
  });
});

describe('paper_question_counts', () => {
  it('gives every full paper its exact count, even past the 1000-row cap', async () => {
    const counts = await countsFor(student, fullPapers);

    for (const paper of fullPapers) {
      expect(counts.get(paper)).toBe(FULL);
    }
  });

  it('returns one row per paper, never one per question', async () => {
    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ n: number }>(
        `select count(*)::int as n from public.paper_question_counts
         where paper_id = any($1::uuid[])`,
        [fullPapers as string[]],
      );
      return Number(res.rows[0].n);
    });

    expect(rows).toBe(FULL_PAPERS);
  });

  it('leaves out a paper with no live question, so the page can read it as zero', async () => {
    const counts = await countsFor(student, [emptyPaper, draftPaper]);

    expect(counts.has(emptyPaper)).toBe(false);
    expect(counts.has(draftPaper)).toBe(false);
  });

  it('counts under the same row rules: an unapproved teacher stays hidden', async () => {
    const asStudent = await countsFor(student, [hiddenPaper]);
    expect(asStudent.has(hiddenPaper)).toBe(false);

    // The teacher sees their own drafts, so their own rows do count for them.
    const asOwner = await countsFor(pending, [hiddenPaper]);
    expect(asOwner.get(hiddenPaper)).toBe(7);
  });

  it('is read-only for the API roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      const res = await db.admin.query<{ privilege_type: string }>(
        `select privilege_type
         from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name = 'paper_question_counts'
           and grantee = $1`,
        [role],
      );
      expect(res.rows.map((r) => r.privilege_type).sort()).toEqual(['SELECT']);
    }
  });
});
