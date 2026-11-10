/**
 * The list links and Retake, counted in `attempts` rows (57c-review-links-and-retake).
 *
 * Persona-1 gap 5 was never about a reader. 57a proved `readAttemptReview()`
 * writes nothing and 57b built the two review routes, yet the lists still sent
 * "Review" to `play`, the START route, so the gap stayed open: every look at a
 * finished test created or resumed a sitting, and in exam mode a timed one.
 *
 * The component tests prove each link's `href`. THIS test proves what those
 * two URLs DO to the database, on real Postgres through PGlite, because the
 * whole claim is a row count and a fake would agree with whatever we wrote:
 *
 *  1. OPENING THE REVIEW ROUTE ADDS 0 `attempts` ROWS, for a paper and for a
 *     test, in practice mode and in exam mode, and whether or not there is
 *     anything to review. Looking three times is still 0.
 *  2. FOLLOWING RETAKE ADDS EXACTLY 1. The review page's `retakeHref` is the
 *     `play` path of the same parent, and `play` resumes the open sitting or
 *     inserts one. After a SUBMITTED sitting there is nothing to resume, so the
 *     count goes up by one and the new row is open.
 *  3. RETAKE TWICE IS STILL ONE NEW SITTING. The second visit resumes the row
 *     the first one made, which is why re-opening the player (or a double
 *     render in dev) leaves no trail.
 *  4. A NEW SITTING DOES NOT CHANGE THE REVIEW. The review is the newest
 *     SUBMITTED sitting, so the fresh open row is invisible to it and a student
 *     who taps Retake and goes Back still sees the paper they finished.
 *
 * Seed with `db.admin` (bypasses RLS), read and write with `db.asUser`: the
 * insert the start route makes has to pass `attempts_insert_own` for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';
import { readAttemptReview } from '@/lib/attempts/review';
import type {
  AttemptAnswer,
  AttemptMode,
  ResultAttempt,
  ResultQuestion,
  ReviewSource,
  ReviewTarget,
} from '@/lib/attempts/types';

let db: TestDb;
let teacher: string;
let student: string;

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
async function insertTest(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, 'Test 1', 1, 90, true)
     returning id`,
    [setId],
  );
  return res.rows[0].id;
}

/** One LIVE, CHECKED question, on the paper or on the test. */
async function insertQuestion(
  number: number,
  correctIdx: number,
  where: { onTest?: boolean } = {},
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        teacher_explanation, checked, status)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, true, 'live')
     returning id`,
    [
      teacher,
      where.onTest ? null : paperId,
      where.onTest ? testId : null,
      number,
      `Question ${number}: which house is the Council of States?`,
      OPTIONS_JSON,
      correctIdx,
      `Article 80 names it. Question ${number}.`,
    ],
  );
  return res.rows[0].id;
}

// --------------------------------------------------------------------------
// What each ROUTE does, in SQL, as the student
// --------------------------------------------------------------------------

/**
 * `/play`, THE START ROUTE, and the target of Retake.
 *
 * The SQL shape of `openOrStartForPaper` / `openOrStartForTest`: the open
 * sitting of this parent in this mode and topic, or a new one. Resuming rather
 * than always inserting is why re-opening the player leaves no trail; the
 * insert runs through `attempts_insert_own`, so RLS gets its say.
 */
function openPlayRoute(
  userId: string,
  where: { onTest?: boolean; mode?: AttemptMode } = {},
): Promise<string> {
  const mode = where.mode ?? 'practice';
  const paper = where.onTest ? null : paperId;
  const test = where.onTest ? testId : null;
  return db.asUser(userId, async (sql) => {
    const open = await sql.query<{ id: string }>(
      `select id from public.attempts
       where submitted_at is null
         and ($1::uuid is null or paper_id = $1::uuid)
         and ($2::uuid is null or test_id  = $2::uuid)
         and mode = $3
         and topic_id is null
       order by started_at desc
       limit 1`,
      [paper, test, mode],
    );
    if (open.rows[0]) return open.rows[0].id;

    const started = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode)
       values ($1, $2, $3, $4)
       returning id`,
      [userId, paper, test, mode],
    );
    return started.rows[0].id;
  });
}

/** The player's upsert. `is_correct` is NULL: 0031 works the verdict out. */
function answer(
  userId: string,
  attemptId: string,
  questionId: string,
  chosenIdx: number | null,
): Promise<void> {
  return db.asUser(userId, async (sql) => {
    await sql.query(
      `insert into public.attempt_answers
         (attempt_id, question_id, chosen_idx, is_correct, marked)
       values ($1, $2, $3, null, false)
       on conflict (attempt_id, question_id) do update
         set chosen_idx = excluded.chosen_idx`,
      [attemptId, questionId, chosenIdx],
    );
  });
}

/** `score_attempt()`: the server marks and closes. */
function submit(userId: string, attemptId: string): Promise<number | null> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ score: number | null }>(
      'select public.score_attempt($1::uuid) as score',
      [attemptId],
    );
    return res.rows[0].score;
  });
}

/** Every `attempts` row, read with the owner handle so RLS cannot hide one. */
async function countAttempts(): Promise<number> {
  const res = await db.admin.query<{ n: string }>('select count(*) as n from public.attempts');
  return Number(res.rows[0].n);
}

/** Every `attempt_answers` row, so a write one level down is caught too. */
async function countAnswers(): Promise<number> {
  const res = await db.admin.query<{ n: string }>(
    'select count(*) as n from public.attempt_answers',
  );
  return Number(res.rows[0].n);
}

async function isOpen(attemptId: string): Promise<boolean> {
  const res = await db.admin.query<{ submitted_at: Date | null }>(
    'select submitted_at from public.attempts where id = $1',
    [attemptId],
  );
  return res.rows[0]?.submitted_at === null;
}

// --------------------------------------------------------------------------
// `/review`: the read-only port, driven by real SQL as the student
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

function readRow(row: AttemptRow | undefined): ResultAttempt | null {
  if (!row) return null;
  const read: ResultAttempt = {
    id: row.id,
    userId: row.user_id,
    paperId: row.paper_id,
    testId: row.test_id,
    mode: row.mode === 'exam' ? 'exam' : 'practice',
    topicId: row.topic_id,
    startedAt: row.started_at.toISOString(),
    deadlineAt: row.deadline_at === null ? null : row.deadline_at.toISOString(),
    submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
    score: row.score,
  };
  return read;
}

function sourceFor(userId: string): ReviewSource {
  return {
    async readNewestSubmitted(target: ReviewTarget) {
      return db.asUser(userId, async (sql) => {
        const res = await sql.query<AttemptRow>(
          `select id, user_id, paper_id, test_id, mode, topic_id,
                  started_at, deadline_at, submitted_at, score
           from public.attempts
           where submitted_at is not null
             and ($1::uuid is null or paper_id = $1::uuid)
             and ($2::uuid is null or test_id  = $2::uuid)
             and ($3::text is null or mode = $3::text)
           order by submitted_at desc
           limit 1`,
          [target.paperId ?? null, target.testId ?? null, target.mode ?? null],
        );
        return readRow(res.rows[0]);
      });
    },

    async readAttempt(attemptId) {
      return db.asUser(userId, async (sql) => {
        const res = await sql.query<AttemptRow>(
          `select id, user_id, paper_id, test_id, mode, topic_id,
                  started_at, deadline_at, submitted_at, score
           from public.attempts where id = $1`,
          [attemptId],
        );
        return readRow(res.rows[0]);
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
           order by number`,
          [attempt.paperId, attempt.testId],
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
      return db.asUser(userId, async (sql) => {
        const out = new Map<string, number>();
        try {
          const res = await sql.query<{ question_id: string; correct_idx: number }>(
            'select question_id, correct_idx from public.question_keys($1::uuid[])',
            [[...questionIds]],
          );
          for (const row of res.rows) out.set(row.question_id, row.correct_idx);
        } catch {
          // The key lock talking (F-E5): an empty map, and the screen says so.
          return out;
        }
        return out;
      });
    },

    async readExplanations(questionIds) {
      return db.asUser(userId, async (sql) => {
        const out = new Map<string, string>();
        try {
          const res = await sql.query<{ question_id: string; teacher_explanation: string | null }>(
            `select question_id, teacher_explanation
             from public.question_explanations($1::uuid[])`,
            [[...questionIds]],
          );
          for (const row of res.rows) {
            if (typeof row.teacher_explanation === 'string' && row.teacher_explanation !== '') {
              out.set(row.question_id, row.teacher_explanation);
            }
          }
        } catch {
          return out;
        }
        return out;
      });
    },
  };
}

/** `/review`: what the review PAGE does, and all it does. */
function openReviewRoute(target: ReviewTarget, userId = student) {
  return readAttemptReview(sourceFor(userId), target);
}

/** One finished practice sitting of the paper. Returns its id. */
async function finishedPaperSitting(): Promise<string> {
  const q1 = await insertQuestion(1, 1);
  const q2 = await insertQuestion(2, 2);
  const attempt = await openPlayRoute(student);
  await answer(student, attempt, q1, 1);
  await answer(student, attempt, q2, 0);
  await submit(student, attempt);
  return attempt;
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
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.papers');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  paperId = await insertPaper();
  setId = await insertSet();
  testId = await insertTest();
});

// --------------------------------------------------------------------------
// 1. The review route is a read
// --------------------------------------------------------------------------
describe('opening the review route of a finished paper', () => {
  it('adds 0 attempts rows and 0 answer rows', async () => {
    await finishedPaperSitting();
    const attempts = await countAttempts();
    const answers = await countAnswers();
    expect(attempts).toBe(1);

    const review = await openReviewRoute({ paperId });

    expect(review).not.toBeNull();
    expect(await countAttempts()).toBe(attempts);
    expect(await countAnswers()).toBe(answers);
  });

  it('still adds 0 when the student looks three times', async () => {
    await finishedPaperSitting();

    await openReviewRoute({ paperId });
    await openReviewRoute({ paperId });
    await openReviewRoute({ paperId });

    expect(await countAttempts()).toBe(1);
  });

  it('adds 0 when there is NOTHING to review', async () => {
    await insertQuestion(1, 1);

    const review = await openReviewRoute({ paperId });

    expect(review).toBeNull();
    expect(await countAttempts()).toBe(0);
  });
});

describe('opening the review route of a finished mock test', () => {
  it('adds 0 attempts rows, in practice mode', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const attempt = await openPlayRoute(student, { onTest: true });
    await answer(student, attempt, q1, 1);
    await submit(student, attempt);
    expect(await countAttempts()).toBe(1);

    expect(await openReviewRoute({ testId })).not.toBeNull();
    expect(await countAttempts()).toBe(1);
  });

  /**
   * The worst shape of the old bug: "Review" went to `play?mode=exam`, so a
   * look at a finished exam started a NEW TIMED one. The review route has no
   * mode in it at all and takes the mode off the row, so the only
   * `deadline_at` in the table is still the finished sitting's own.
   */
  it('adds 0 attempts rows for an exam sitting, and starts no second clock', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const attempt = await openPlayRoute(student, { onTest: true, mode: 'exam' });
    await answer(student, attempt, q1, 1);
    await submit(student, attempt);
    expect(await countAttempts()).toBe(1);

    const review = await openReviewRoute({ testId });

    expect(review?.mode).toBe('exam');
    expect(await countAttempts()).toBe(1);
    const clocks = await db.admin.query<{ n: string }>(
      'select count(*) as n from public.attempts where deadline_at is not null',
    );
    expect(Number(clocks.rows[0].n)).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 2. Retake is the one thing that starts a sitting
// --------------------------------------------------------------------------
describe('following Retake from the review page', () => {
  it('adds exactly 1 new attempts row, and it is open', async () => {
    const first = await finishedPaperSitting();
    await openReviewRoute({ paperId });
    expect(await countAttempts()).toBe(1);

    // `retakeHref` is the `play` path of the same paper.
    const retaken = await openPlayRoute(student);

    expect(await countAttempts()).toBe(2);
    expect(retaken).not.toBe(first);
    expect(await isOpen(retaken)).toBe(true);
    expect(await isOpen(first)).toBe(false);
  });

  it('adds exactly 1 for a mock test too, in the mode of the sitting', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const first = await openPlayRoute(student, { onTest: true, mode: 'exam' });
    await answer(student, first, q1, 1);
    await submit(student, first);
    await openReviewRoute({ testId });

    const retaken = await openPlayRoute(student, { onTest: true, mode: 'exam' });

    expect(await countAttempts()).toBe(2);
    expect(retaken).not.toBe(first);
    expect(await isOpen(retaken)).toBe(true);
  });

  it('is still ONE new sitting when Retake is followed twice', async () => {
    await finishedPaperSitting();

    const once = await openPlayRoute(student);
    const twice = await openPlayRoute(student);

    expect(twice).toBe(once);
    expect(await countAttempts()).toBe(2);
  });

  /**
   * The review is the newest SUBMITTED sitting, so the row Retake just made is
   * invisible to it: a student who taps Retake and then goes Back still sees
   * the paper they finished, not an empty one.
   */
  it('leaves the review showing the sitting that was finished', async () => {
    const first = await finishedPaperSitting();
    const retaken = await openPlayRoute(student);

    const review = await openReviewRoute({ paperId });

    expect(review?.attemptId).toBe(first);
    expect(review?.attemptId).not.toBe(retaken);
    expect(await countAttempts()).toBe(2);
  });
});
