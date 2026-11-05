/**
 * Thumbs up / down on an AI explanation (issue 23-revision-screen).
 *
 * DESIGN.md section 8: "Thumbs up/down under it (feedback goes to the
 * teacher)." Two rules follow from that one sentence, and both are decided in
 * Postgres, not in the screen:
 *
 *  1. ONE OPINION PER STUDENT. The primary key is
 *     `(user_id, question_id, lang)`, so a student who taps up and then down
 *     has one row that says `down`, not two rows that cancel out.
 *  2. THE TEACHER READS IT, NOBODY ELSE. A student reads their own vote. The
 *     teacher who owns the question reads every vote on it. Another student
 *     reads nothing at all, because a vote is an opinion about a paid
 *     explanation and not public.
 *
 * Seed with `db.admin` (bypasses RLS), assert through `db.asUser` (Postgres
 * evaluates every policy for real) -- the rule in web/CLAUDE.md.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the paper and the question. */
let teacher: string;
/** The student who votes. */
let student: string;
/** A second student. Must never see the first one's vote. */
let other: string;

let liveQuestion: string;

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

interface VoteRow {
  user_id: string;
  question_id: string;
  lang: string;
  vote: string;
}

/** Vote the way the route does: as the signed-in student, upsert. */
function vote(userId: string, questionId: string, value: string, lang = 'en') {
  return db.asUser(userId, async (sql) => {
    await sql.query(
      `insert into public.ai_feedback (question_id, lang, vote)
       values ($1, $2, $3)
       on conflict (user_id, question_id, lang) do update set vote = excluded.vote`,
      [questionId, lang, value],
    );
  });
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

  const paper = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Paper 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacher, NET],
  );

  const made = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values ($1, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live')
     returning id`,
    [teacher, paper.rows[0].id, OPTIONS],
  );
  liveQuestion = made.rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.ai_feedback');
});

it('the migration is applied', () => {
  expect(db.migrations).toContain('0023_ai_feedback.sql');
});

it('a student votes and reads their own vote back', async () => {
  await vote(student, liveQuestion, 'up');

  const rows = await db.asUser(student, async (sql) => {
    const r = await sql.query<VoteRow>('select * from public.ai_feedback');
    return r.rows;
  });

  expect(rows).toHaveLength(1);
  // `user_id` defaults to auth.uid(), so the screen never sends an id and
  // cannot send somebody else's.
  expect(rows[0].user_id).toBe(student);
  expect(rows[0].vote).toBe('up');
});

it('a second tap changes the one vote instead of adding a row', async () => {
  await vote(student, liveQuestion, 'up');
  await vote(student, liveQuestion, 'down');

  const r = await db.admin.query<VoteRow>('select * from public.ai_feedback');
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0].vote).toBe('down');
});

it('English and Hindi are two votes, because they are two explanations', async () => {
  await vote(student, liveQuestion, 'up', 'en');
  await vote(student, liveQuestion, 'down', 'hi');

  const r = await db.admin.query<VoteRow>(
    'select lang, vote from public.ai_feedback order by lang',
  );
  expect(r.rows.map((one) => [one.lang, one.vote])).toEqual([
    ['en', 'up'],
    ['hi', 'down'],
  ]);
});

it('only up and down are votes', async () => {
  await expect(vote(student, liveQuestion, 'maybe')).rejects.toThrow();
});

it('another student cannot read or change the vote', async () => {
  await vote(student, liveQuestion, 'up');

  const seen = await db.asUser(other, async (sql) => {
    const r = await sql.query<VoteRow>('select * from public.ai_feedback');
    return r.rows;
  });
  expect(seen).toHaveLength(0);

  await db.asUser(other, async (sql) => {
    await sql.query("update public.ai_feedback set vote = 'down'");
  });

  const stored = await db.admin.query<VoteRow>('select vote from public.ai_feedback');
  expect(stored.rows[0].vote).toBe('up');
});

it('the question owner reads the votes on their own question', async () => {
  await vote(student, liveQuestion, 'down');

  const seen = await db.asUser(teacher, async (sql) => {
    const r = await sql.query<VoteRow>('select * from public.ai_feedback');
    return r.rows;
  });

  expect(seen).toHaveLength(1);
  expect(seen[0].vote).toBe('down');
});

it('a student cannot vote as somebody else', async () => {
  await db.asUser(student, async (sql) => {
    await expect(
      sql.query(
        `insert into public.ai_feedback (user_id, question_id, lang, vote)
         values ($1, $2, 'en', 'up')`,
        [other, liveQuestion],
      ),
    ).rejects.toThrow();
  });

  const r = await db.admin.query('select 1 from public.ai_feedback');
  expect(r.rows).toHaveLength(0);
});

it('nobody signed in writes nothing', async () => {
  await db.asAnon(async (sql) => {
    await expect(
      sql.query(
        `insert into public.ai_feedback (question_id, lang, vote)
         values ($1, 'en', 'up')`,
        [liveQuestion],
      ),
    ).rejects.toThrow();
  });
});
