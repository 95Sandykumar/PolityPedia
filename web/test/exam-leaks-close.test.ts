/**
 * The FOUR ways a student still got the answer mid-exam (issue
 * 36-exam-leaks-close).
 *
 * Issues 30 and 31 moved F-E5 into Postgres: the column privilege on
 * `questions.correct_idx` is gone, `question_keys()` is the one way in and it
 * refuses while a sitting is open, and a practice sitting of a test being sat
 * cannot be started. An independent re-check then PROVED, with probes like
 * the ones in this file, that the key still left the building four ways:
 *
 *  1. DELETE THE SITTING. `attempts_delete_own` (0013) let a student delete
 *     their own unsubmitted exam attempt. With the row gone `has_open_exam()`
 *     is false, `question_keys()` answers, `practice_verdict()` answers, the
 *     practice tab opens, and a fresh sitting starts with a new deadline.
 *  2. `questions.teacher_explanation`. 0030 revoked ONE column. The prose
 *     explanation next to it says "Option C is right" in words, and
 *     `src/lib/exam/types.ts` itself lists the field as answer key.
 *  3. THE SAVED AI EXPLANATION. `ai_explanations_select_visible` (0022) only
 *     asked "can you read the question", and the saved text quotes the
 *     correct option. `claim_explanation_audio` (0032) had no exam check at
 *     all, so the audio of a ready explanation was claimable mid-paper.
 *  4. THE DEADLINE CLAUSE. `claim_ai_explanation` (0032) treated a sitting as
 *     open only while `now() < deadline_at`. `has_open_exam()` does not: an
 *     unsubmitted paper is still unmarked. So after the deadline with no
 *     submit, the model call was allowed while the key stayed locked.
 *
 * Every probe here FAILED (that is, leaked) before `0037_exam_leaks_close.sql`.
 *
 * Seed with `db.admin` (bypasses RLS), act through `db.asUser` so Postgres
 * evaluates every policy, every column privilege and every `auth.uid()` for
 * real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearClaimSecrets, readClaim } from './claim-secrets';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** The approved teacher who owns the set, its test and every question. */
let teacher: string;
/** The student who sits the timed test. */
let student: string;

/** CUET PG from the 0004 seed: +4 and -1, so one right answer scores 4. */
const CUET = 'a4000001-0000-4000-8000-000000000002';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);
const EXPLANATION = 'Article 80 names the Rajya Sabha the Council of States.';

const BODY = JSON.stringify({
  exam: 'CUET PG',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'The Rajya Sabha, option B.' }],
  remember: 'Rajya Sabha = Council of States.',
});

let setId: string;
/** The free sample, so the paywall is never the thing doing the refusing. */
let testId: string;
/** A past paper, for the cascade and past-paper probes. */
let paperId: string;

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

async function insertSet(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, 'live')
     returning id`,
    [teacher, CUET],
  );
  return res.rows[0].id;
}

async function insertTest(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, 'Test 1', 1, 90, true)
     returning id`,
    [setId],
  );
  return res.rows[0].id;
}

async function insertPaper(): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Paper 1 2024', 'papers/p.pdf', 'live')
     returning id`,
    [teacher, CUET],
  );
  return res.rows[0].id;
}

/** One question of the mock test, live and checked unless told otherwise. */
async function insertQuestion(
  number = 1,
  correctIdx = 1,
  status: 'draft' | 'live' = 'live',
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx,
        teacher_explanation, checked, status)
     values ($1, null, $2, $3, 'Which house is the Council of States?',
             $4::jsonb, $5, $6, true, $7)
     returning id`,
    [teacher, testId, number, OPTIONS, correctIdx, EXPLANATION, status],
  );
  return res.rows[0].id;
}

/** The exact insert the exam load route makes, as the student themselves. */
function startExam(userId: string): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, test_id, mode, deadline_at)
       values ($1, null, $2, 'exam', now() + interval '90 minutes')
       returning id`,
      [userId, testId],
    );
    return res.rows[0].id;
  });
}

/** The exact insert the practice page makes. */
function startPractice(userId: string): Promise<unknown> {
  return db.asUser(userId, (sql) =>
    sql.query(
      `insert into public.attempts (user_id, paper_id, test_id, mode)
       values ($1, null, $2, 'practice')`,
      [userId, testId],
    ),
  );
}

/** What the student's own DELETE achieves. Rows removed, 0 when RLS refused. */
function deleteAttempt(userId: string, attemptId: string): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query('delete from public.attempts where id = $1', [attemptId]);
    return res.affectedRows ?? 0;
  });
}

async function attemptExists(attemptId: string): Promise<boolean> {
  const res = await db.admin.query('select 1 from public.attempts where id = $1', [attemptId]);
  return res.rows.length === 1;
}

function questionKeys(userId: string, ids: string[]): Promise<Map<string, number>> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ question_id: string; correct_idx: number }>(
      'select question_id, correct_idx from public.question_keys($1::uuid[])',
      [ids],
    );
    return new Map(res.rows.map((row) => [row.question_id, row.correct_idx]));
  });
}

/** The new way in for the prose explanation, the twin of question_keys(). */
function questionExplanations(userId: string, ids: string[]): Promise<Map<string, string | null>> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ question_id: string; teacher_explanation: string | null }>(
      'select question_id, teacher_explanation from public.question_explanations($1::uuid[])',
      [ids],
    );
    return new Map(res.rows.map((row) => [row.question_id, row.teacher_explanation]));
  });
}

/** Hole 2 as one REST request, in SQL: the prose straight off the table. */
function selectExplanationDirectly(userId: string): Promise<unknown> {
  return db.asUser(userId, (sql) =>
    sql.query('select number, teacher_explanation from public.questions where test_id = $1', [
      testId,
    ]),
  );
}

function scoreAttempt(userId: string, attemptId: string): Promise<number | null> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ score: number | null }>(
      'select public.score_attempt($1::uuid) as score',
      [attemptId],
    );
    return res.rows[0].score;
  });
}

/** One saved explanation, ready to read, with its audio unclaimed. */
async function seedExplanation(questionId: string, lang = 'en'): Promise<void> {
  await db.admin.query(
    `insert into public.ai_explanations (question_id, lang, status, body, sources, model)
     values ($1, $2, 'ready', $3::jsonb, '[]'::jsonb, 'claude-haiku-5-5')`,
    [questionId, lang, BODY],
  );
}

/** What the caller's own SELECT on ai_explanations returns. */
function readExplanations(userId: string, questionId: string): Promise<unknown[]> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query(
      'select question_id, status, body from public.ai_explanations where question_id = $1',
      [questionId],
    );
    return res.rows;
  });
}

async function grantPlan(userId: string): Promise<void> {
  await db.admin.query(
    `insert into public.entitlements (user_id, plan, valid_until, source)
     values ($1, 'ai', now() + interval '30 days', 'admin')
     on conflict (user_id, plan) do update set valid_until = excluded.valid_until`,
    [userId],
  );
}

/**
 * Both claims answer `{code, secret}` since issue 37-ai-claim-secret. This
 * file only ever asserts on the WORD, which is what the exam gate decides.
 */
function claim(userId: string, questionId: string, lang = 'en'): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ out: unknown }>(
      'select public.claim_ai_explanation($1, $2) as out',
      [questionId, lang],
    );
    return readClaim('text', userId, questionId, lang, res.rows[0].out);
  });
}

function claimAudio(userId: string, questionId: string, lang = 'en'): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ out: unknown }>(
      'select public.claim_explanation_audio($1, $2) as out',
      [questionId, lang],
    );
    return readClaim('audio', userId, questionId, lang, res.rows[0].out);
  });
}

/** Push an open sitting past its deadline without submitting it. */
async function expireDeadline(attemptId: string): Promise<void> {
  await db.admin.query(
    `update public.attempts
       set started_at = now() - interval '3 hours', deadline_at = now() - interval '1 hour'
     where id = $1`,
    [attemptId],
  );
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
  clearClaimSecrets();
  await db.admin.query('delete from public.ai_explanations');
  await db.admin.query('delete from public.ai_usage');
  await db.admin.query('delete from public.entitlements');
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.papers');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  setId = await insertSet();
  testId = await insertTest();
  paperId = await insertPaper();
});

describe('0037_exam_leaks_close', () => {
  it('ships as a migration named for this issue', () => {
    expect(db.migrations).toContain('0037_exam_leaks_close.sql');
  });

  // ------------------------------------------------------------------
  // 1. Hole one: delete the sitting, read the key
  // ------------------------------------------------------------------

  describe('hole 1: an open exam sitting cannot be deleted', () => {
    it('refuses the student their own DELETE of an unsubmitted exam sitting', async () => {
      const attempt = await startExam(student);

      expect(await deleteAttempt(student, attempt)).toBe(0);
      expect(await attemptExists(attempt)).toBe(true);
    });

    it('keeps question_keys() locked after the delete was attempted', async () => {
      const id = await insertQuestion();
      const attempt = await startExam(student);

      await deleteAttempt(student, attempt);

      await expect(questionKeys(student, [id])).rejects.toThrow();
    });

    it('keeps the practice tab shut after the delete was attempted', async () => {
      const attempt = await startExam(student);
      await deleteAttempt(student, attempt);

      await expect(startPractice(student)).rejects.toThrow();
    });

    it('keeps practice_verdict() silent after the delete was attempted', async () => {
      const id = await insertQuestion(1, 1);
      // A practice sitting opened BEFORE the exam, the way 0030 allows.
      const practice = await db.asUser(student, async (sql) => {
        const res = await sql.query<{ id: string }>(
          `insert into public.attempts (user_id, paper_id, test_id, mode)
           values ($1, null, $2, 'practice')
           returning id`,
          [student, testId],
        );
        return res.rows[0].id;
      });
      const attempt = await startExam(student);
      await deleteAttempt(student, attempt);

      const verdict = await db.asUser(student, async (sql) => {
        const res = await sql.query<{ v: boolean | null }>(
          'select public.practice_verdict($1, $2, 1) as v',
          [practice, id],
        );
        return res.rows[0].v;
      });
      expect(verdict).toBeNull();
    });

    it('still lets a student delete a SUBMITTED exam sitting', async () => {
      const id = await insertQuestion();
      const attempt = await startExam(student);
      await db.asUser(student, (sql) =>
        sql.query(
          `insert into public.attempt_answers (attempt_id, question_id, chosen_idx)
           values ($1, $2, 1)`,
          [attempt, id],
        ),
      );
      await scoreAttempt(student, attempt);

      expect(await deleteAttempt(student, attempt)).toBe(1);
    });

    it('still lets a student delete a PRACTICE sitting', async () => {
      const practice = await db.asUser(student, async (sql) => {
        const res = await sql.query<{ id: string }>(
          `insert into public.attempts (user_id, paper_id, test_id, mode)
           values ($1, null, $2, 'practice')
           returning id`,
          [student, testId],
        );
        return res.rows[0].id;
      });

      expect(await deleteAttempt(student, practice)).toBe(1);
    });

    it('still lets a student delete an open PAST PAPER sitting', async () => {
      const sitting = await db.asUser(student, async (sql) => {
        const res = await sql.query<{ id: string }>(
          `insert into public.attempts (user_id, paper_id, test_id, mode)
           values ($1, $2, null, 'practice')
           returning id`,
          [student, paperId],
        );
        return res.rows[0].id;
      });

      expect(await deleteAttempt(student, sitting)).toBe(1);
    });

    it('still cascades an open exam sitting away when the user is deleted', async () => {
      const gone = await db.createUser();
      const res = await db.admin.query<{ id: string }>(
        `insert into public.attempts (user_id, paper_id, test_id, mode, deadline_at)
         values ($1, null, $2, 'exam', now() + interval '90 minutes')
         returning id`,
        [gone, testId],
      );
      const attempt = res.rows[0].id;

      await db.admin.query('delete from auth.users where id = $1', [gone]);

      expect(await attemptExists(attempt)).toBe(false);
    });

    it('still lets the owner (admin, service role) delete an open sitting', async () => {
      const attempt = await startExam(student);
      const res = await db.admin.query('delete from public.attempts where id = $1', [attempt]);
      expect(res.affectedRows ?? 0).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // 2. Hole two: teacher_explanation
  // ------------------------------------------------------------------

  describe('hole 2: teacher_explanation is not a readable column', () => {
    it('refuses a direct read of teacher_explanation to a student in an open exam', async () => {
      await insertQuestion();
      await startExam(student);

      await expect(selectExplanationDirectly(student)).rejects.toThrow();
    });

    it('refuses that direct read with no sitting at all, like correct_idx', async () => {
      await insertQuestion();
      await expect(selectExplanationDirectly(student)).rejects.toThrow();
    });

    it('refuses the owning teacher the same direct read, so there is one way in', async () => {
      await insertQuestion(1, 1, 'draft');
      await expect(selectExplanationDirectly(teacher)).rejects.toThrow();
    });

    it('still hands a student every other column of a live question', async () => {
      const id = await insertQuestion();
      await startExam(student);

      const rows = await db.asUser(student, async (sql) => {
        const res = await sql.query<{ id: string; stem: string }>(
          'select id, number, stem, options, status from public.questions where test_id = $1',
          [testId],
        );
        return res.rows;
      });

      expect(rows.map((row) => row.id)).toEqual([id]);
      expect(rows[0].stem).toContain('Council of States');
    });

    it('refuses question_explanations() while an exam sitting is open', async () => {
      const id = await insertQuestion();
      await startExam(student);

      await expect(questionExplanations(student, [id])).rejects.toThrow();
    });

    it('keeps refusing after the deadline until the sitting is submitted', async () => {
      const id = await insertQuestion();
      const attempt = await startExam(student);
      await expireDeadline(attempt);

      await expect(questionExplanations(student, [id])).rejects.toThrow();
    });

    it('hands the explanation over once the sitting is submitted', async () => {
      const id = await insertQuestion();
      const attempt = await startExam(student);
      await scoreAttempt(student, attempt);

      expect(await questionExplanations(student, [id])).toEqual(new Map([[id, EXPLANATION]]));
    });

    it('hands a teacher the explanation of their own question, even mid-exam', async () => {
      const id = await insertQuestion(1, 1, 'draft');
      await startExam(teacher);

      expect(await questionExplanations(teacher, [id])).toEqual(new Map([[id, EXPLANATION]]));
    });

    it('never hands over the explanation of a question that is still a draft', async () => {
      const id = await insertQuestion(1, 1, 'draft');
      expect(await questionExplanations(student, [id])).toEqual(new Map());
    });

    it('never hands over the explanation of a test the student has not unlocked', async () => {
      await db.admin.query('update public.mock_tests set is_free_sample = false where id = $1', [
        testId,
      ]);
      const id = await insertQuestion();

      expect(await questionExplanations(student, [id])).toEqual(new Map());
    });

    it('refuses question_explanations() to nobody at all', async () => {
      const id = await insertQuestion();
      await expect(
        db.asAnon((sql) =>
          sql.query('select * from public.question_explanations($1::uuid[])', [[id]]),
        ),
      ).rejects.toThrow();
    });

    it('answers an empty list with no rows and no refusal', async () => {
      expect(await questionExplanations(student, [])).toEqual(new Map());
    });

    it('still lets the owning teacher WRITE the explanation', async () => {
      const id = await insertQuestion(1, 1, 'draft');

      const changed = await db.asUser(teacher, (sql) =>
        sql.query('update public.questions set teacher_explanation = $2 where id = $1', [
          id,
          'Rewritten by the teacher.',
        ]),
      );
      expect(changed.affectedRows ?? 0).toBe(1);
      expect(await questionExplanations(teacher, [id])).toEqual(
        new Map([[id, 'Rewritten by the teacher.']]),
      );
    });
  });

  // ------------------------------------------------------------------
  // 3. Hole three: the saved AI explanation and its audio
  // ------------------------------------------------------------------

  describe('hole 3: a saved AI explanation is not readable mid-exam', () => {
    it('returns the saved explanation to a student with no open sitting', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);

      expect(await readExplanations(student, id)).toHaveLength(1);
    });

    it('returns ZERO rows while an exam sitting of that test is open', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);
      await startExam(student);

      expect(await readExplanations(student, id)).toHaveLength(0);
    });

    it('returns the rows again once the sitting is submitted', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);
      const attempt = await startExam(student);
      expect(await readExplanations(student, id)).toHaveLength(0);

      await scoreAttempt(student, attempt);
      expect(await readExplanations(student, id)).toHaveLength(1);
    });

    it('keeps refusing after the deadline until the sitting is submitted', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);
      const attempt = await startExam(student);
      await expireDeadline(attempt);

      expect(await readExplanations(student, id)).toHaveLength(0);
    });

    it('never hides it from the teacher who owns the question', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);
      await startExam(teacher);

      expect(await readExplanations(teacher, id)).toHaveLength(1);
    });

    it('refuses the audio claim of a ready explanation mid-exam', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);
      await startExam(student);

      expect(await claimAudio(student, id)).toBe('not_found');
    });

    it('allows the audio claim once the sitting is submitted', async () => {
      const id = await insertQuestion();
      await seedExplanation(id);
      const attempt = await startExam(student);
      await scoreAttempt(student, attempt);

      expect(await claimAudio(student, id)).toBe('claimed');
    });
  });

  // ------------------------------------------------------------------
  // 4. Hole four: the deadline clause on the claim
  // ------------------------------------------------------------------

  describe('hole 4: the claim uses has_open_exam(), not the deadline', () => {
    it('refuses a new claim after the deadline while the sitting is unsubmitted', async () => {
      const id = await insertQuestion();
      await grantPlan(student);
      const attempt = await startExam(student);
      await expireDeadline(attempt);

      // The key is still locked for this sitting, so the model call that
      // would quote it must be locked too.
      await expect(questionKeys(student, [id])).rejects.toThrow();
      expect(await claim(student, id)).toBe('not_found');
    });

    it('still refuses a claim before the deadline', async () => {
      const id = await insertQuestion();
      await grantPlan(student);
      await startExam(student);

      expect(await claim(student, id)).toBe('not_found');
    });

    it('allows the claim once the sitting is submitted', async () => {
      const id = await insertQuestion();
      await grantPlan(student);
      const attempt = await startExam(student);
      await scoreAttempt(student, attempt);

      expect(await claim(student, id)).toBe('claimed');
    });

    it('leaves a student with no sitting at all alone', async () => {
      const id = await insertQuestion();
      await grantPlan(student);

      expect(await claim(student, id)).toBe('claimed');
    });
  });
});
