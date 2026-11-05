/**
 * `questions.job_id` and `claim_ingest_job()` (issue 12-pdf-split-worker).
 *
 * Real Postgres through PGlite, so the CHECK constraints, the partial index
 * and the claim statement are the ones that ship. RLS is evaluated for real:
 * `authenticated` has no BYPASSRLS (test/db.ts).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/** One exam from the 0004 seed, by its fixed id. Same as questions.test.ts. */
const NET = 'a4000001-0000-4000-8000-000000000001';

/**
 * An approved teacher with one draft paper. Returns the ids.
 *
 * No `profiles` insert: 0003 has a trigger that creates the profile row on
 * signup, so `createUser()` already made it.
 */
async function seedPaper(): Promise<{ teacher: string; paper: string }> {
  const teacher = await db.createUser();

  await db.admin.query(
    "insert into public.teachers (user_id, alias, status) values ($1, $2, 'approved')",
    [teacher, 'teacher-' + teacher.slice(0, 8)],
  );

  const paper = (
    await db.admin.query<{ id: string }>(
      `insert into public.papers
         (teacher_id, exam_id, year, label, pdf_questions_path)
       values ($1, $2, 2024, $3, 'path/q.pdf')
       returning id`,
      [teacher, NET, 'Shift ' + teacher.slice(0, 8)],
    )
  ).rows[0].id;

  return { teacher, paper };
}

async function seedJob(
  teacher: string,
  paper: string,
  status = 'queued',
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.ingest_jobs (teacher_id, paper_id, pdf_path, status)
     values ($1, $2, 'path/q.pdf', $3) returning id`,
    [teacher, paper, status],
  );
  return res.rows[0].id;
}

it('applies this issue\'s migration', () => {
  expect(db.migrations).toContain('0012_split_jobs.sql');
});

it('hangs a draft question on the job that produced it', async () => {
  const { teacher, paper } = await seedPaper();
  const job = await seedJob(teacher, paper);

  await db.admin.query(
    `insert into public.questions
       (teacher_id, paper_id, job_id, number, stem, options, correct_idx)
     values ($1, $2, $3, 1, 'Who?', $4, 0)`,
    [teacher, paper, job, JSON.stringify(['a', 'b', 'c', 'd'])],
  );

  const rows = await db.admin.query<{ job_id: string; status: string; checked: boolean }>(
    'select job_id, status, checked from public.questions where paper_id = $1',
    [paper],
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].job_id).toBe(job);
  // What the worker writes is always an unchecked draft (Risk 1).
  expect(rows.rows[0].status).toBe('draft');
  expect(rows.rows[0].checked).toBe(false);
});

it('keeps the questions when the job row is deleted', async () => {
  const { teacher, paper } = await seedPaper();
  const job = await seedJob(teacher, paper);

  await db.admin.query(
    `insert into public.questions
       (teacher_id, paper_id, job_id, number, stem, options, correct_idx)
     values ($1, $2, $3, 1, 'Who?', $4, 0)`,
    [teacher, paper, job, JSON.stringify(['a', 'b', 'c', 'd'])],
  );

  await db.admin.query('delete from public.ingest_jobs where id = $1', [job]);

  // `on delete set null`, never cascade: a published question must not vanish
  // because somebody tidied up the job table.
  const rows = await db.admin.query<{ job_id: string | null }>(
    'select job_id from public.questions where paper_id = $1',
    [paper],
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].job_id).toBeNull();
});

/**
 * Empty the queue. The claim tests below assert WHICH row comes next, so they
 * have to start from a known queue; PGlite keeps one database for the whole
 * file, and the tests above leave jobs in it.
 */
async function emptyQueue(): Promise<void> {
  await db.admin.query('delete from public.ingest_jobs');
}

it('claims one queued job, oldest first, and marks it running', async () => {
  await emptyQueue();
  const { teacher, paper } = await seedPaper();

  const first = await seedJob(teacher, paper);
  // A second row created later, so `order by created_at` has something to do.
  await db.admin.query(
    "update public.ingest_jobs set created_at = now() - interval '1 minute' where id = $1",
    [first],
  );
  const second = await seedJob(teacher, paper);

  const claimed = await db.admin.query<{
    id: string;
    status: string;
    attempts: number;
    error: string | null;
  }>('select id, status, attempts, error from public.claim_ingest_job()');

  expect(claimed.rows).toHaveLength(1);
  expect(claimed.rows[0].id).toBe(first);
  expect(claimed.rows[0].status).toBe('running');
  // Each RUN counts its own three tries, so a claim starts at 1.
  expect(claimed.rows[0].attempts).toBe(1);
  expect(claimed.rows[0].error).toBeNull();

  // The row really moved, so a second claim cannot pick it up again.
  const after = await db.admin.query<{ status: string }>(
    'select status from public.ingest_jobs where id = $1',
    [first],
  );
  expect(after.rows[0].status).toBe('running');

  const next = await db.admin.query<{ id: string }>('select id from public.claim_ingest_job()');
  expect(next.rows[0].id).toBe(second);

  // Queue empty: no rows, not an error.
  const empty = await db.admin.query('select id from public.claim_ingest_job()');
  expect(empty.rows).toHaveLength(0);
});

it('clears last run\'s error when it claims a retried job', async () => {
  const { teacher, paper } = await seedPaper();
  const job = await seedJob(teacher, paper, 'failed');
  await db.admin.query(
    "update public.ingest_jobs set attempts = 3, error = 'bad-answer' where id = $1",
    [job],
  );

  // The teacher presses retry.
  await db.admin.query("update public.ingest_jobs set status = 'queued' where id = $1", [job]);

  const claimed = await db.admin.query<{ attempts: number; error: string | null }>(
    'select attempts, error from public.claim_ingest_job()',
  );
  // Three FRESH tries, and the old reason is gone off the teacher's screen.
  expect(claimed.rows[0].attempts).toBe(1);
  expect(claimed.rows[0].error).toBeNull();
});

it('never claims another teacher\'s job for a signed-in caller', async () => {
  const mine = await seedPaper();
  const theirs = await seedPaper();
  const theirJob = await seedJob(theirs.teacher, theirs.paper);

  const rows = await db.asUser(mine.teacher, async (sql) => {
    const res = await sql.query<{ id: string }>('select id from public.claim_ingest_job()');
    return res.rows;
  });

  // RLS, not the function body, is what stops them: `ingest_jobs_update_own`.
  expect(rows).toHaveLength(0);

  const untouched = await db.admin.query<{ status: string; attempts: number }>(
    'select status, attempts from public.ingest_jobs where id = $1',
    [theirJob],
  );
  expect(untouched.rows[0].status).toBe('queued');
  expect(untouched.rows[0].attempts).toBe(0);
});

it('refuses a fourth attempt and a 201st question', async () => {
  const { teacher, paper } = await seedPaper();
  const job = await seedJob(teacher, paper);

  // `ingest_jobs_attempts_check`: 3 tries, full stop (design.md F4).
  await expect(
    db.admin.query('update public.ingest_jobs set attempts = 4 where id = $1', [job]),
  ).rejects.toThrow(/attempts/);

  // `ingest_jobs_count_check` / `questions_number_check`: 200 per PDF (F-D2).
  await expect(
    db.admin.query('update public.ingest_jobs set question_count = 201 where id = $1', [job]),
  ).rejects.toThrow(/count/);

  await expect(
    db.admin.query(
      `insert into public.questions
         (teacher_id, paper_id, job_id, number, stem, options, correct_idx)
       values ($1, $2, $3, 201, 'Who?', $4, 0)`,
      [teacher, paper, job, JSON.stringify(['a', 'b', 'c', 'd'])],
    ),
  ).rejects.toThrow(/number/);
});
