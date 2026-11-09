/**
 * The result read for one submitted sitting (issue 56a-result-reader).
 *
 * This is the first half of ticket 56: the numbers a result page shows, with
 * no screen anywhere near them. Ticket 56 draws them.
 *
 * WHY THIS TEST RUNS ON REAL POSTGRES. Three of the four rules in the issue
 * are DATABASE rules, and a fake would agree with whatever the reader does:
 *
 *   * the score is the one `score_attempt()` stored (0031), so the test
 *     TAMPERS with the stored number and proves the reader repeats it instead
 *     of working it out again from the answers,
 *   * the answer key is reachable only through `question_keys()` (0030), and
 *     `questions.correct_idx` is not selectable by `authenticated` at all, so
 *     a reader that tried the easy way would fail right here,
 *   * another student's sitting is hidden by `attempts_select_own` (0013), not
 *     by an `if` in TypeScript.
 *
 * The reader therefore takes a `ResultSource` port, and the port is driven by
 * PGlite SQL below, as the student, through `db.asUser`. Every policy, column
 * privilege and trigger is evaluated for real.
 *
 * Seed with `db.admin` (bypasses RLS), read with `db.asUser`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';
import { readAttemptResult, shortStem } from '@/lib/attempts/result';
import type {
  AttemptAnswer,
  ResultAttempt,
  ResultQuestion,
  ResultSource,
} from '@/lib/attempts/types';

let db: TestDb;

/** The approved teacher who owns the paper, the set and every question. */
let teacher: string;
/** The student whose sitting this is. */
let student: string;
/** Somebody else, who must not read it. */
let other: string;

/** CUET PG, from the 0004 seed: +4 and -1, so marking shows in a score. */
const CUET = 'a4000001-0000-4000-8000-000000000002';

const OPTIONS = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];
const OPTIONS_JSON = JSON.stringify(OPTIONS);

let paperId: string;
let setId: string;
let testId: string;

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

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

async function insertSet(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, 'live')
     returning id`,
    [teacher, CUET],
  );
  return res.rows[0].id;
}

/** A FREE SAMPLE test, so `has_test_access` is true with no purchase. */
async function insertTest(durationMin = 90): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, 'Test 1', 1, $2, true)
     returning id`,
    [setId, durationMin],
  );
  return res.rows[0].id;
}

/** One LIVE, CHECKED question. The key varies, so a wrong list can be read. */
async function insertQuestion(
  number: number,
  correctIdx: number,
  where: { onTest?: boolean; stem?: string } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        checked, status)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, true, 'live')
     returning id`,
    [
      teacher,
      where.onTest ? null : paperId,
      where.onTest ? testId : null,
      number,
      where.stem ?? `Question ${number}: which house is the Council of States?`,
      OPTIONS_JSON,
      correctIdx,
    ],
  );
  return res.rows[0].id;
}

/** Start a sitting the way the app does: as the student, through RLS. */
function startAttempt(
  userId: string,
  values: { mode?: string; onTest?: boolean } = {},
): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode)
       values ($1, $2, $3, $4)
       returning id`,
      [
        userId,
        values.onTest ? null : paperId,
        values.onTest ? testId : null,
        values.mode ?? 'practice',
      ],
    );
    return res.rows[0].id;
  });
}

/**
 * The player's upsert.
 *
 * `is_correct` is sent as NULL on purpose. 0031 recomputes a practice verdict
 * from `questions.correct_idx` on the way in, and REFUSES a verdict on an exam
 * answer outright, so null is the one value both halves accept. The verdict in
 * every assertion below is therefore Postgres's own.
 */
function answer(
  userId: string,
  attemptId: string,
  questionId: string,
  values: { chosenIdx?: number | null; marked?: boolean } = {},
): Promise<void> {
  const chosenIdx = values.chosenIdx ?? null;
  return db.asUser(userId, async (sql) => {
    await sql.query(
      `insert into public.attempt_answers
         (attempt_id, question_id, chosen_idx, is_correct, marked)
       values ($1, $2, $3, $4, $5)
       on conflict (attempt_id, question_id) do update
         set chosen_idx = excluded.chosen_idx,
             is_correct = excluded.is_correct,
             marked     = excluded.marked`,
      [attemptId, questionId, chosenIdx, null, values.marked ?? false],
    );
  });
}

/** `score_attempt()`: the server marks and closes. Returns the stored score. */
function submit(userId: string, attemptId: string): Promise<number | null> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ score: number | null }>(
      'select public.score_attempt($1::uuid) as score',
      [attemptId],
    );
    return res.rows[0].score;
  });
}

/** Move the start of a sitting with the OWNER handle (a student may not). */
async function backdate(attemptId: string, startedMinutesAgo: number): Promise<void> {
  await db.admin.query(
    `update public.attempts
     set started_at = now() - ($2 * interval '1 minute')
     where id = $1`,
    [attemptId, startedMinutesAgo],
  );
}

// --------------------------------------------------------------------------
// The port, driven by real SQL as the student
// --------------------------------------------------------------------------

interface AttemptRow {
  id: string;
  user_id: string;
  paper_id: string | null;
  test_id: string | null;
  mode: string;
  topic_id: string | null;
  started_at: Date;
  deadline_at: Date | null;
  submitted_at: Date | null;
  score: number | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The question id lists the reader asked a key for, in order. */
let keyReads: string[][] = [];

function sourceFor(userId: string): ResultSource {
  return {
    async readAttempt(attemptId) {
      return db.asUser(userId, async (sql) => {
        const res = await sql.query<AttemptRow>(
          `select id, user_id, paper_id, test_id, mode, topic_id,
                  started_at, deadline_at, submitted_at, score
           from public.attempts where id = $1`,
          [attemptId],
        );
        const row = res.rows[0];
        if (!row) return null;
        const read: ResultAttempt = {
          id: row.id,
          userId: row.user_id,
          paperId: row.paper_id,
          testId: row.test_id,
          mode: row.mode === 'exam' ? 'exam' : 'practice',
          topicId: row.topic_id,
          startedAt: row.started_at.toISOString(),
          deadlineAt: iso(row.deadline_at),
          submittedAt: iso(row.submitted_at),
          score: row.score,
        };
        return read;
      });
    },

    async readQuestions(attempt) {
      return db.asUser(userId, async (sql) => {
        // NOTE: no `correct_idx` and no `teacher_explanation`. 0030 and 0037
        // revoked both columns from `authenticated`, so asking would fail.
        const res = await sql.query<{
          id: string;
          number: number;
          stem: string;
          options: unknown;
        }>(
          `select id, number, stem, options
           from public.questions
           where status = 'live'
             and ($1::uuid is null or paper_id = $1::uuid)
             and ($2::uuid is null or test_id = $2::uuid)
             and ($3::uuid is null or topic_id = $3::uuid)
           order by number`,
          [attempt.paperId, attempt.testId, attempt.topicId],
        );
        return res.rows.map((row) => {
          const found: ResultQuestion = {
            id: row.id,
            number: row.number,
            stem: row.stem,
            options: row.options as ResultQuestion['options'],
          };
          return found;
        });
      });
    },

    async readAnswers(attemptId) {
      return db.asUser(userId, async (sql) => {
        const res = await sql.query<{
          question_id: string;
          chosen_idx: number | null;
          is_correct: boolean | null;
          marked: boolean;
        }>(
          `select question_id, chosen_idx, is_correct, marked
           from public.attempt_answers where attempt_id = $1`,
          [attemptId],
        );
        const out = new Map<string, AttemptAnswer>();
        for (const row of res.rows) {
          out.set(row.question_id, {
            chosenIdx: row.chosen_idx,
            isCorrect: row.is_correct,
            marked: row.marked === true,
          });
        }
        return out;
      });
    },

    async readKeys(questionIds) {
      keyReads.push([...questionIds]);
      return db.asUser(userId, async (sql) => {
        const res = await sql.query<{ question_id: string; correct_idx: number }>(
          'select question_id, correct_idx from public.question_keys($1::uuid[])',
          [[...questionIds]],
        );
        const out = new Map<string, number>();
        for (const row of res.rows) out.set(row.question_id, row.correct_idx);
        return out;
      });
    },
  };
}

/** Read one sitting the way a page would. */
function resultOf(attemptId: string, userId = student) {
  return readAttemptResult(sourceFor(userId), attemptId);
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
  keyReads = [];
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.papers');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  paperId = await insertPaper();
  setId = await insertSet();
  testId = await insertTest(90);
});

// --------------------------------------------------------------------------
// 1. The counts, and that they add up
// --------------------------------------------------------------------------
describe('a submitted sitting', () => {
  it('reads all right as a full score and an empty wrong list', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 2);
    const q3 = await insertQuestion(3, 0);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 2 });
    await answer(student, attempt, q3, { chosenIdx: 0 });
    expect(await submit(student, attempt)).toBe(12);

    const result = await resultOf(attempt);

    expect(result).not.toBeNull();
    expect(result?.total).toBe(3);
    expect(result?.right).toBe(3);
    expect(result?.wrong).toBe(0);
    expect(result?.skipped).toBe(0);
    expect(result?.percent).toBe(100);
    expect(result?.score).toBe(12);
    expect(result?.wrongQuestions).toEqual([]);
    // Nothing was wrong, so there was no reason to ask for a key at all.
    expect(keyReads).toEqual([]);
  });

  it('reads all wrong, with the chosen option and the right one', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 2);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 3 });
    await answer(student, attempt, q2, { chosenIdx: 0 });
    // +4 / -1 on CUET PG, so two wrong answers is minus two marks.
    expect(await submit(student, attempt)).toBe(-2);

    const result = await resultOf(attempt);

    expect(result?.right).toBe(0);
    expect(result?.wrong).toBe(2);
    expect(result?.skipped).toBe(0);
    expect(result?.percent).toBe(0);
    expect(result?.score).toBe(-2);

    expect(result?.wrongQuestions).toHaveLength(2);
    const wrong = result?.wrongQuestions ?? [];
    expect(wrong[0].number).toBe(1);
    expect(wrong[0].chosen).toEqual({ idx: 3, letter: 'D', text: 'Neither' });
    expect(wrong[0].right).toEqual({ idx: 1, letter: 'B', text: 'Rajya Sabha' });
    expect(wrong[1].number).toBe(2);
    expect(wrong[1].chosen).toEqual({ idx: 0, letter: 'A', text: 'Lok Sabha' });
    expect(wrong[1].right).toEqual({ idx: 2, letter: 'C', text: 'Both' });
  });

  it('counts an untouched question, and one marked but not answered, as skipped', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 1);
    const q3 = await insertQuestion(3, 1);
    await insertQuestion(4, 1); // never touched at all
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 0 });
    await answer(student, attempt, q3, { chosenIdx: null, marked: true });
    expect(await submit(student, attempt)).toBe(3);

    const result = await resultOf(attempt);

    expect(result?.total).toBe(4);
    expect(result?.right).toBe(1);
    expect(result?.wrong).toBe(1);
    expect(result?.skipped).toBe(2);
    // The whole point of the three counts: together they are the question total.
    expect((result?.right ?? 0) + (result?.wrong ?? 0) + (result?.skipped ?? 0)).toBe(
      result?.total,
    );
    expect(result?.percent).toBe(25);
    expect(result?.score).toBe(3);
  });

  it('reads an empty paper without dividing by zero', async () => {
    const attempt = await startAttempt(student);
    expect(await submit(student, attempt)).toBe(0);

    const result = await resultOf(attempt);

    expect(result?.total).toBe(0);
    expect(result?.percent).toBe(0);
    expect(result?.right).toBe(0);
    expect(result?.wrongQuestions).toEqual([]);
  });

  it('reports the time the sitting took', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await backdate(attempt, 25);
    await submit(student, attempt);

    const result = await resultOf(attempt);

    expect(result?.timeTakenSec).toBeGreaterThanOrEqual(25 * 60);
    expect(result?.timeTakenSec).toBeLessThan(26 * 60);
    expect(result?.autoSubmitted).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 2. The score is the SERVER's number (0031)
// --------------------------------------------------------------------------
describe('the score', () => {
  it('is the stored one, never worked out again from the answers', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 1 });
    expect(await submit(student, attempt)).toBe(8);

    // A moderation fix, or a scheme the reader knows nothing about. Whatever
    // the stored number says, the student sees that, not 8.
    await db.admin.query('update public.attempts set score = 5 where id = $1', [attempt]);

    const result = await resultOf(attempt);

    expect(result?.score).toBe(5);
    // The counts still come from the stored verdicts, so both are right at once.
    expect(result?.right).toBe(2);
  });
});

// --------------------------------------------------------------------------
// 3. The deadline auto-submit returns the same shape
// --------------------------------------------------------------------------
describe('an exam sitting that auto-submitted at the deadline', () => {
  it('reads like any other result, and says it closed on the clock', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const q2 = await insertQuestion(2, 2, { onTest: true });
    const attempt = await startAttempt(student, { mode: 'exam', onTest: true });
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 3 });

    // The clock ran out: the deadline is in the past and the close comes after
    // it. Only the owner handle can move a deadline (0031).
    await db.admin.query(
      `update public.attempts
       set started_at  = now() - interval '95 minutes',
           deadline_at = now() - interval '5 minutes'
       where id = $1`,
      [attempt],
    );
    expect(await submit(student, attempt)).toBe(3);

    const result = await resultOf(attempt);

    expect(result?.mode).toBe('exam');
    expect(result?.autoSubmitted).toBe(true);
    expect(result?.total).toBe(2);
    expect(result?.right).toBe(1);
    expect(result?.wrong).toBe(1);
    expect(result?.skipped).toBe(0);
    expect(result?.score).toBe(3);
    expect(result?.percent).toBe(50);
    expect(result?.wrongQuestions).toHaveLength(1);
    expect(result?.wrongQuestions[0].right).toEqual({ idx: 2, letter: 'C', text: 'Both' });
    expect(result?.timeTakenSec).toBeGreaterThan(90 * 60);
  });
});

// --------------------------------------------------------------------------
// 4. Nothing for somebody else's sitting, and nothing before the close
// --------------------------------------------------------------------------
describe('what the reader refuses', () => {
  it('returns nothing for another student, because RLS hides the row', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await submit(student, attempt);

    // Proof the row is really there and really hidden, not simply absent.
    expect(await resultOf(attempt, student)).not.toBeNull();
    expect(await resultOf(attempt, other)).toBeNull();
  });

  it('returns nothing, and no key, for a sitting that is still open', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 3 });

    expect(await resultOf(attempt)).toBeNull();
    // 0030: the key belongs to a CLOSED sitting. The reader never even asks.
    expect(keyReads).toEqual([]);
  });

  it('returns nothing for an attempt id that does not exist', async () => {
    expect(await resultOf('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('asks for the key of the wrong questions only', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 0 });
    await submit(student, attempt);

    await resultOf(attempt);

    expect(keyReads).toEqual([[q2]]);
  });

  it('still lists a wrong question when the key read comes back empty', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 0 });
    await submit(student, attempt);

    const source = sourceFor(student);
    const result = await readAttemptResult(
      { ...source, readKeys: async () => new Map() },
      attempt,
    );

    expect(result?.wrong).toBe(1);
    expect(result?.wrongQuestions).toHaveLength(1);
    // The key is all or nothing: no half right answer is invented.
    expect(result?.wrongQuestions[0].right).toBeNull();
    expect(result?.wrongQuestions[0].chosen.text).toBe('Lok Sabha');
  });
});

// --------------------------------------------------------------------------
// 5. The one pure helper
// --------------------------------------------------------------------------
describe('shortStem', () => {
  it('keeps a short stem as it is', () => {
    expect(shortStem('Who is the Speaker?')).toBe('Who is the Speaker?');
  });

  it('folds the newlines and runs of spaces a PDF split leaves behind', () => {
    expect(shortStem('Who is   the\n Speaker?\t')).toBe('Who is the Speaker?');
  });

  it('cuts a long stem at a word, never mid-word', () => {
    const long =
      'Which of the following statements about the Council of States is correct in the light of the amendment';
    const cut = shortStem(long);

    expect(cut.length).toBeLessThanOrEqual(91);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('  ');
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });
});
