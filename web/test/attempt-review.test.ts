/**
 * The review read: the newest SUBMITTED sitting, every question (57a-review-reader).
 *
 * The first half of ticket 57 (review and retake). `readAttemptResult` (56a)
 * answers "how did it go": a score and the questions that went wrong, one line
 * each. THIS reader answers the next question a student asks: "show me the
 * whole paper again". Every question, in paper order, with the option they
 * picked, the right one, and the teacher's prose beside it. Ticket 57 draws
 * it; nothing here knows what a pixel is.
 *
 * FOUR RULES, AND THREE OF THEM BELONG TO POSTGRES, so this test runs on real
 * Postgres through PGlite and a fake would agree with whatever the reader did:
 *
 *  1. IT IS A READ. No sitting is created, resumed or closed by looking at a
 *     review, in practice mode or in exam mode. The test counts the `attempts`
 *     rows before and after and they are the same number.
 *  2. THE NEWEST SUBMITTED ONE, never an open one. A student who retakes a
 *     paper reviews the sitting they just finished, and a sitting still in
 *     progress has no review at all: `submitted_at` is the gate (0030).
 *  3. ANOTHER STUDENT'S SITTING IS NOT HIDDEN HERE. `attempts_select_own`
 *     (0013) hides it, and the reader returns null for a row RLS did not hand
 *     over, exactly as "there is no sitting" does. The two must look the same.
 *  4. THE KEY AND THE PROSE ARE ALL OR NOTHING. `question_keys()` (0030) and
 *     `question_explanations()` (0037) both RAISE while the caller has an open
 *     exam sitting of the same test (F-E5), which is a real state: a student
 *     can open the exam in a second tab and then review an older sitting. The
 *     question is still listed, with `right: null` and `explanation: null`, and
 *     the screen says the key is locked. Nothing is invented.
 *
 * Seed with `db.admin` (bypasses RLS), read with `db.asUser`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';
import { readAttemptReview } from '@/lib/attempts/review';
import type {
  AttemptAnswer,
  ResultAttempt,
  ResultQuestion,
  ReviewSource,
  ReviewTarget,
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

/** One LIVE, CHECKED question, with the teacher's prose on it. */
async function insertQuestion(
  number: number,
  correctIdx: number,
  where: { onTest?: boolean; stem?: string; explanation?: string | null } = {},
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
      where.stem ?? `Question ${number}: which house is the Council of States?`,
      OPTIONS_JSON,
      correctIdx,
      where.explanation === undefined
        ? `Article 80 names it. Question ${number}.`
        : where.explanation,
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
 * The player's upsert. `is_correct` is sent as NULL on purpose: 0031 works a
 * practice verdict out from `questions.correct_idx` on the way in and REFUSES
 * one on an exam answer, so null is the value both halves accept and every
 * verdict asserted below is Postgres's own.
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

/** Move a sitting back in time with the OWNER handle (a student may not). */
async function backdate(attemptId: string, minutesAgo: number): Promise<void> {
  await db.admin.query(
    `update public.attempts
     set started_at   = now() - ($2 * interval '1 minute'),
         submitted_at = case when submitted_at is null then null
                        else now() - ($2 * interval '1 minute') + interval '1 minute' end
     where id = $1`,
    [attemptId, minutesAgo],
  );
}

/** Every `attempts` row in the database, read with the owner handle. */
async function countAttempts(): Promise<number> {
  const res = await db.admin.query<{ n: string }>('select count(*) as n from public.attempts');
  return Number(res.rows[0].n);
}

/** Every `attempt_answers` row, so a write hiding one level down is caught too. */
async function countAnswers(): Promise<number> {
  const res = await db.admin.query<{ n: string }>(
    'select count(*) as n from public.attempt_answers',
  );
  return Number(res.rows[0].n);
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
    deadlineAt: iso(row.deadline_at),
    submittedAt: iso(row.submitted_at),
    score: row.score,
  };
  return read;
}

/** The id lists the reader asked a key for, in order. */
let keyReads: string[][] = [];
/** The id lists the reader asked prose for, in order. */
let proseReads: string[][] = [];

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
        const out = new Map<string, number>();
        try {
          const res = await sql.query<{ question_id: string; correct_idx: number }>(
            'select question_id, correct_idx from public.question_keys($1::uuid[])',
            [[...questionIds]],
          );
          for (const row of res.rows) out.set(row.question_id, row.correct_idx);
        } catch {
          // The key lock talking (F-E5). An empty map, exactly as the Supabase
          // driver turns the 403 into one, so the screen can say "locked".
          return out;
        }
        return out;
      });
    },

    async readExplanations(questionIds) {
      proseReads.push([...questionIds]);
      return db.asUser(userId, async (sql) => {
        const out = new Map<string, string>();
        try {
          const res = await sql.query<{
            question_id: string;
            teacher_explanation: string | null;
          }>(
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
          // The twin lock of `question_keys()`, same error, same answer.
          return out;
        }
        return out;
      });
    },
  };
}

/** Read a review the way a page would. */
function reviewOf(target: ReviewTarget, userId = student) {
  return readAttemptReview(sourceFor(userId), target);
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
  proseReads = [];
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
// 1. Every question, with the answer, the key and the prose
// --------------------------------------------------------------------------
describe('the review of a submitted sitting', () => {
  it('lists every question with the chosen option, the right one and the prose', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 2);
    const q3 = await insertQuestion(3, 0);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 0 });
    await answer(student, attempt, q3, { chosenIdx: null, marked: true });
    expect(await submit(student, attempt)).toBe(3);

    const review = await reviewOf({ paperId });

    expect(review).not.toBeNull();
    expect(review?.attemptId).toBe(attempt);
    expect(review?.mode).toBe('practice');
    expect(review?.score).toBe(3);
    expect(review?.total).toBe(3);
    expect(review?.right).toBe(1);
    expect(review?.wrong).toBe(1);
    expect(review?.skipped).toBe(1);

    const questions = review?.questions ?? [];
    expect(questions).toHaveLength(3);

    // Right: the chosen option IS the key, and the prose is beside it.
    expect(questions[0].number).toBe(1);
    expect(questions[0].questionId).toBe(q1);
    expect(questions[0].isCorrect).toBe(true);
    expect(questions[0].chosen).toEqual({ idx: 1, letter: 'B', text: 'Rajya Sabha' });
    expect(questions[0].right).toEqual({ idx: 1, letter: 'B', text: 'Rajya Sabha' });
    expect(questions[0].explanation).toBe('Article 80 names it. Question 1.');
    // Every option, with the letter the student saw on the button.
    expect(questions[0].options).toEqual([
      { idx: 0, letter: 'A', text: 'Lok Sabha' },
      { idx: 1, letter: 'B', text: 'Rajya Sabha' },
      { idx: 2, letter: 'C', text: 'Both' },
      { idx: 3, letter: 'D', text: 'Neither' },
    ]);

    // Wrong: both options are there, and they differ.
    expect(questions[1].isCorrect).toBe(false);
    expect(questions[1].chosen).toEqual({ idx: 0, letter: 'A', text: 'Lok Sabha' });
    expect(questions[1].right).toEqual({ idx: 2, letter: 'C', text: 'Both' });

    // Skipped: no answer, the key is still shown, and the mark is remembered.
    expect(questions[2].isCorrect).toBeNull();
    expect(questions[2].chosen).toBeNull();
    expect(questions[2].right).toEqual({ idx: 0, letter: 'A', text: 'Lok Sabha' });
    expect(questions[2].marked).toBe(true);
  });

  it('keeps the WHOLE stem, unlike the one-line result list', async () => {
    const long =
      'Which of the following statements about the Council of States is correct in the light of the amendment';
    const q1 = await insertQuestion(1, 1, { stem: long });
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await submit(student, attempt);

    const review = await reviewOf({ paperId });

    expect(review?.questions[0].stem).toBe(long);
  });

  it('shows no prose when the teacher wrote none, and still shows the key', async () => {
    const q1 = await insertQuestion(1, 1, { explanation: null });
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 3 });
    await submit(student, attempt);

    const review = await reviewOf({ paperId });

    expect(review?.questions[0].explanation).toBeNull();
    expect(review?.questions[0].right).toEqual({ idx: 1, letter: 'B', text: 'Rajya Sabha' });
  });

  it('reviews a mock test by its test id', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const attempt = await startAttempt(student, { mode: 'exam', onTest: true });
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await submit(student, attempt);

    const review = await reviewOf({ testId });

    expect(review?.attemptId).toBe(attempt);
    expect(review?.mode).toBe('exam');
    expect(review?.questions).toHaveLength(1);
    expect(review?.questions[0].right).toEqual({ idx: 1, letter: 'B', text: 'Rajya Sabha' });
  });
});

// --------------------------------------------------------------------------
// 2. The NEWEST submitted sitting, and only a submitted one
// --------------------------------------------------------------------------
describe('which sitting the review is of', () => {
  it('takes the newest submitted one, not an older one', async () => {
    const q1 = await insertQuestion(1, 1);

    const older = await startAttempt(student);
    await answer(student, older, q1, { chosenIdx: 0 });
    await submit(student, older);
    await backdate(older, 120);

    const newer = await startAttempt(student);
    await answer(student, newer, q1, { chosenIdx: 1 });
    await submit(student, newer);

    const review = await reviewOf({ paperId });

    expect(review?.attemptId).toBe(newer);
    // The retake went right, so the review shows the retake's answer.
    expect(review?.questions[0].isCorrect).toBe(true);
    expect(review?.right).toBe(1);
  });

  it('ignores a sitting still open and reviews the submitted one behind it', async () => {
    const q1 = await insertQuestion(1, 1);

    const done = await startAttempt(student);
    await answer(student, done, q1, { chosenIdx: 1 });
    await submit(student, done);

    // The retake is under way. Its answers are not a review.
    const open = await startAttempt(student);
    await answer(student, open, q1, { chosenIdx: 3 });

    const review = await reviewOf({ paperId });

    expect(review?.attemptId).toBe(done);
    expect(review?.questions[0].chosen).toEqual({
      idx: 1,
      letter: 'B',
      text: 'Rajya Sabha',
    });
    expect(open).not.toBe(done);
  });
});

// --------------------------------------------------------------------------
// 3. What the reader refuses
// --------------------------------------------------------------------------
describe('what the review refuses', () => {
  it('returns nothing, and asks for no key, when the only sitting is open', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 3 });

    expect(await reviewOf({ paperId })).toBeNull();
    // 0030: the key and the prose belong to a CLOSED sitting. Neither is asked.
    expect(keyReads).toEqual([]);
    expect(proseReads).toEqual([]);
  });

  it('returns nothing when the student never sat the paper at all', async () => {
    await insertQuestion(1, 1);

    expect(await reviewOf({ paperId })).toBeNull();
    expect(keyReads).toEqual([]);
  });

  it('returns nothing for another student, because RLS hides the row', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await submit(student, attempt);

    // Proof the row is really there and really hidden, not simply absent.
    expect(await reviewOf({ paperId }, student)).not.toBeNull();
    expect(await reviewOf({ paperId }, other)).toBeNull();
  });

  it('returns nothing when no parent, or both parents, are asked for', async () => {
    const q1 = await insertQuestion(1, 1);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await submit(student, attempt);

    // `attempts_one_parent_check` (0013): a sitting has exactly one parent, so
    // a request with none or two is a bug upstream and reads as nothing.
    expect(await reviewOf({})).toBeNull();
    expect(await reviewOf({ paperId, testId })).toBeNull();
    expect(await reviewOf({ paperId: 'not-a-uuid' })).toBeNull();
    expect(keyReads).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 4. It is a READ (the rule this slice exists for)
// --------------------------------------------------------------------------
describe('the review never writes', () => {
  it('leaves the attempts and answers rows exactly as they were, in practice mode', async () => {
    const q1 = await insertQuestion(1, 1);
    const q2 = await insertQuestion(2, 2);
    const attempt = await startAttempt(student);
    await answer(student, attempt, q1, { chosenIdx: 1 });
    await answer(student, attempt, q2, { chosenIdx: 0 });
    await submit(student, attempt);

    const attemptsBefore = await countAttempts();
    const answersBefore = await countAnswers();
    const stored = await db.admin.query<{ submitted_at: Date; score: number | null }>(
      'select submitted_at, score from public.attempts where id = $1',
      [attempt],
    );

    // Read it twice: a reader that resumed or re-opened a sitting would show
    // up on the second call even if the first looked innocent.
    expect(await reviewOf({ paperId })).not.toBeNull();
    expect(await reviewOf({ paperId })).not.toBeNull();

    expect(await countAttempts()).toBe(attemptsBefore);
    expect(await countAnswers()).toBe(answersBefore);
    const after = await db.admin.query<{ submitted_at: Date; score: number | null }>(
      'select submitted_at, score from public.attempts where id = $1',
      [attempt],
    );
    expect(after.rows[0].score).toBe(stored.rows[0].score);
    expect(after.rows[0].submitted_at.toISOString()).toBe(
      stored.rows[0].submitted_at.toISOString(),
    );
  });

  it('leaves the attempts rows exactly as they were, in exam mode', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const attempt = await startAttempt(student, { mode: 'exam', onTest: true });
    await answer(student, attempt, q1, { chosenIdx: 3 });
    await submit(student, attempt);

    const attemptsBefore = await countAttempts();
    const answersBefore = await countAnswers();

    expect(await reviewOf({ testId })).not.toBeNull();
    expect(await reviewOf({ testId })).not.toBeNull();

    expect(await countAttempts()).toBe(attemptsBefore);
    expect(await countAnswers()).toBe(answersBefore);
  });

  it('writes nothing even when there is no sitting to review', async () => {
    await insertQuestion(1, 1);
    const before = await countAttempts();

    expect(await reviewOf({ paperId })).toBeNull();

    expect(await countAttempts()).toBe(before);
  });
});

// --------------------------------------------------------------------------
// 5. The key lock is a STATE, not a crash (F-E5)
// --------------------------------------------------------------------------
describe('an open exam sitting in another tab', () => {
  it('lists the questions with no key and no prose, instead of failing', async () => {
    const q1 = await insertQuestion(1, 1, { onTest: true });
    const q2 = await insertQuestion(2, 2, { onTest: true });

    const done = await startAttempt(student, { mode: 'exam', onTest: true });
    await answer(student, done, q1, { chosenIdx: 1 });
    await answer(student, done, q2, { chosenIdx: 0 });
    await submit(student, done);

    // The second tab: a NEW exam sitting of the same test, still open. Both
    // `question_keys()` and `question_explanations()` now raise.
    await startAttempt(student, { mode: 'exam', onTest: true });

    const review = await reviewOf({ testId, mode: 'exam' });

    expect(review?.attemptId).toBe(done);
    expect(review?.questions).toHaveLength(2);
    // The student's own answers are theirs, and never locked.
    expect(review?.questions[0].chosen).toEqual({
      idx: 1,
      letter: 'B',
      text: 'Rajya Sabha',
    });
    expect(review?.questions[0].isCorrect).toBe(true);
    // The key and the prose are. All or nothing: nothing is invented.
    expect(review?.questions[0].right).toBeNull();
    expect(review?.questions[0].explanation).toBeNull();
    expect(review?.questions[1].right).toBeNull();
    expect(review?.questions[1].explanation).toBeNull();
    // The counts come from the STORED verdicts, so they survive the lock.
    expect(review?.right).toBe(1);
    expect(review?.wrong).toBe(1);
  });
});
