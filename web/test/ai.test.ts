/**
 * Saved AI explanations and the 30-a-day cap (issue 22-revision-api).
 *
 * The promise is F-F4: ONE AI call per question and language, ever. That
 * cannot live in a route handler, because two route handlers can run at the
 * same moment on two machines. It lives in the primary key of
 * `ai_explanations`, and this file proves it in Postgres:
 *
 *  1. no plan            -> `no_plan`, and nothing is written.
 *  2. a saved one        -> `ready`, and the counter does not move.
 *  3. the 31st new one   -> `limit`, and nothing is written.
 *  4. two claims at once -> ONE `claimed`, one `generating`, counter = 1.
 *  5. a failure          -> status `failed` AND the count is given back.
 *  6. a student cannot touch `ai_usage` or `ai_explanations` directly.
 *
 * Seed with `db.admin` (bypasses RLS), assert through `db.asUser` (Postgres
 * evaluates every policy for real).
 *
 * The two CLAIM calls run as the student (`db.asUser`). `finish` and `fail`
 * run as `db.asService`, because issue 41-ai-finish-server-only moved them to
 * `service_role` only: a student's key cannot reach them at all any more.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearClaimSecrets, heldSecret, readClaim } from './claim-secrets';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the paper and both questions. */
let teacher: string;
/** Student on the AI plan. The happy path. */
let aiUser: string;
/** A second student on Pro. The other half of the race test. */
let proUser: string;
/** Student on no plan at all. */
let freeUser: string;

let paper: string;
/** A published question every student may read. */
let liveQuestion: string;
/** A draft. Only its teacher may reach it. */
let draftQuestion: string;

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);
const BODY = JSON.stringify({
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
  remember: 'Rajya Sabha = Council of States.',
});

interface UsageRow {
  new_count: number;
}

interface ExplanationRow {
  status: string;
  body: unknown;
  sources: unknown;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  searches: number | null;
  edited_by_teacher: boolean;
}

/**
 * Call the gate the way a route handler does: as the signed-in student.
 *
 * Since issue 37-ai-claim-secret a claim answers `{code, secret}`, and the
 * secret is the only copy there will ever be. `readClaim` keeps it the way
 * the route keeps it in memory; `heldSecret` hands it back to `finish` and
 * `failCall` below.
 */
function claim(userId: string, questionId: string, lang = 'en'): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ out: unknown }>(
      'select public.claim_ai_explanation($1, $2) as out',
      [questionId, lang],
    );
    return readClaim('text', userId, questionId, lang, r.rows[0].out);
  });
}

/**
 * Finish as OUR SERVER does it (issue 41-ai-finish-server-only).
 *
 * `finish_ai_explanation` is granted to `service_role` alone now, so this
 * runs through `db.asService`. `userId` stays in the signature because it is
 * how the held secret is looked up: the server holds the secret of the claim
 * that user won, exactly as the route handler holds it in a local variable.
 */
function finish(userId: string, questionId: string, lang = 'en'): Promise<boolean> {
  return db.asService(async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      `select public.finish_ai_explanation(
                $1, $2, $3::jsonb, $4::jsonb, 'claude-haiku-5-5', 900, 450, 2, $5::uuid
              ) as saved`,
      [
        questionId,
        lang,
        BODY,
        JSON.stringify([{ title: 'India Code', url: 'https://x' }]),
        heldSecret('text', userId, questionId, lang),
      ],
    );
    return r.rows[0].saved;
  });
}

/** Fail as OUR SERVER does it: `service_role` only (issue 41). */
function failCall(userId: string, questionId: string, lang = 'en'): Promise<boolean> {
  return db.asService(async (sql) => {
    const r = await sql.query<{ gave_back: boolean }>(
      'select public.fail_ai_explanation($1, $2, $3::uuid) as gave_back',
      [questionId, lang, heldSecret('text', userId, questionId, lang)],
    );
    return r.rows[0].gave_back;
  });
}

/** Today's counter, read with the owner handle so RLS never hides it. */
async function usedToday(userId: string): Promise<number> {
  const r = await db.admin.query<UsageRow>(
    'select new_count from public.ai_usage where user_id = $1 and ist_date = public.ist_today()',
    [userId],
  );
  return r.rows[0]?.new_count ?? 0;
}

async function storedExplanation(
  questionId: string,
  lang = 'en',
): Promise<ExplanationRow | null> {
  const r = await db.admin.query<ExplanationRow>(
    `select status, body, sources, model, tokens_in, tokens_out, searches, edited_by_teacher
     from public.ai_explanations where question_id = $1 and lang = $2`,
    [questionId, lang],
  );
  return r.rows[0] ?? null;
}

/** Give a student a live plan, the way the admin screen does. */
async function grant(userId: string, plan: 'ai' | 'pro'): Promise<void> {
  await db.admin.query(
    `insert into public.entitlements (user_id, plan, valid_until, source)
     values ($1, $2, now() + interval '30 days', 'admin')
     on conflict (user_id, plan) do update set valid_until = excluded.valid_until`,
    [userId, plan],
  );
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  aiUser = await db.createUser();
  proUser = await db.createUser();
  freeUser = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacher],
  );

  await grant(aiUser, 'ai');
  await grant(proUser, 'pro');

  const p = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Paper 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacher, NET],
  );
  paper = p.rows[0].id;

  const made = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values
       ($1, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live'),
       ($1, $2, 2, 'Who appoints the Governor?', $3::jsonb, 0, false, 'draft')
     returning id`,
    [teacher, paper, OPTIONS],
  );
  liveQuestion = made.rows[0].id;
  draftQuestion = made.rows[1].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  clearClaimSecrets();
  await db.admin.query('delete from public.ai_explanations');
  await db.admin.query('delete from public.ai_usage');
});

describe('0022_ai.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0022_ai.sql');
  });

  it('counts the India day, not the UTC one', async () => {
    const r = await db.admin.query<{ ist: string; cap: number }>(
      "select public.ist_today()::text as ist, public.ai_daily_cap() as cap",
    );
    // Asia/Kolkata is UTC+5:30, so the India date is today or tomorrow in UTC
    // terms, never yesterday.
    const utc = new Date().toISOString().slice(0, 10);
    expect(r.rows[0].ist >= utc).toBe(true);
    expect(r.rows[0].cap).toBe(30);
  });
});

describe('claim_ai_explanation: the plan gate', () => {
  it('refuses a student on no plan and writes nothing', async () => {
    expect(await claim(freeUser, liveQuestion)).toBe('no_plan');
    expect(await storedExplanation(liveQuestion)).toBeNull();
    expect(await usedToday(freeUser)).toBe(0);
  });

  it('refuses a question that is still a draft', async () => {
    expect(await claim(aiUser, draftQuestion)).toBe('not_found');
    expect(await storedExplanation(draftQuestion)).toBeNull();
    expect(await usedToday(aiUser)).toBe(0);
  });

  it('refuses a question id that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000999';
    expect(await claim(aiUser, missing)).toBe('not_found');
    expect(await usedToday(aiUser)).toBe(0);
  });
});

describe('claim_ai_explanation: a saved explanation is free', () => {
  it('returns ready and does not move the counter', async () => {
    expect(await claim(aiUser, liveQuestion)).toBe('claimed');
    expect(await finish(aiUser, liveQuestion)).toBe(true);
    expect(await usedToday(aiUser)).toBe(1);

    // The same student again, and a different student: both free.
    expect(await claim(aiUser, liveQuestion)).toBe('ready');
    expect(await claim(proUser, liveQuestion)).toBe('ready');

    expect(await usedToday(aiUser)).toBe(1);
    expect(await usedToday(proUser)).toBe(0);
  });

  it('stores the model, tokens and search count for the cost check', async () => {
    await claim(aiUser, liveQuestion);
    await finish(aiUser, liveQuestion);

    const row = await storedExplanation(liveQuestion);
    expect(row?.status).toBe('ready');
    expect(row?.model).toBe('claude-haiku-5-5');
    expect(row?.tokens_in).toBe(900);
    expect(row?.tokens_out).toBe(450);
    expect(row?.searches).toBe(2);
    expect(row?.edited_by_teacher).toBe(false);
  });

  it('keeps English and Hindi apart', async () => {
    expect(await claim(aiUser, liveQuestion, 'en')).toBe('claimed');
    await finish(aiUser, liveQuestion, 'en');
    // Hindi is a different explanation, so it is a new call.
    expect(await claim(aiUser, liveQuestion, 'hi')).toBe('claimed');
    expect(await usedToday(aiUser)).toBe(2);
  });
});

describe('claim_ai_explanation: 30 a day', () => {
  it('refuses the 31st new explanation with limit', async () => {
    await db.admin.query(
      `insert into public.ai_usage (user_id, ist_date, new_count)
       values ($1, public.ist_today(), 30)`,
      [aiUser],
    );

    expect(await claim(aiUser, liveQuestion)).toBe('limit');
    expect(await storedExplanation(liveQuestion)).toBeNull();
    expect(await usedToday(aiUser)).toBe(30);
  });

  it('still returns a SAVED explanation to a student at the cap', async () => {
    expect(await claim(proUser, liveQuestion)).toBe('claimed');
    await finish(proUser, liveQuestion);

    await db.admin.query(
      `insert into public.ai_usage (user_id, ist_date, new_count)
       values ($1, public.ist_today(), 30)`,
      [aiUser],
    );
    expect(await claim(aiUser, liveQuestion)).toBe('ready');
    expect(await usedToday(aiUser)).toBe(30);
  });

  it('lets the 30th through', async () => {
    await db.admin.query(
      `insert into public.ai_usage (user_id, ist_date, new_count)
       values ($1, public.ist_today(), 29)`,
      [aiUser],
    );
    expect(await claim(aiUser, liveQuestion)).toBe('claimed');
    expect(await usedToday(aiUser)).toBe(30);
  });
});

describe('claim_ai_explanation: the race', () => {
  it('lets exactly one claimer through, and only charges that one', async () => {
    const first = await claim(aiUser, liveQuestion);
    const second = await claim(proUser, liveQuestion);

    expect(first).toBe('claimed');
    // The loser is told the answer is on its way. It costs nothing.
    expect(second).toBe('generating');

    expect(await usedToday(aiUser)).toBe(1);
    expect(await usedToday(proUser)).toBe(0);

    const rows = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.ai_explanations where question_id = $1',
      [liveQuestion],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('does not charge the same student twice for one question', async () => {
    expect(await claim(aiUser, liveQuestion)).toBe('claimed');
    expect(await claim(aiUser, liveQuestion)).toBe('generating');
    expect(await usedToday(aiUser)).toBe(1);
  });
});

describe('fail_ai_explanation: the call is given back', () => {
  it('marks it failed and restores the count', async () => {
    expect(await claim(aiUser, liveQuestion)).toBe('claimed');
    expect(await usedToday(aiUser)).toBe(1);

    expect(await failCall(aiUser, liveQuestion)).toBe(true);

    expect((await storedExplanation(liveQuestion))?.status).toBe('failed');
    expect(await usedToday(aiUser)).toBe(0);
  });

  it('lets a failed explanation be retried, and counts the retry', async () => {
    await claim(aiUser, liveQuestion);
    await failCall(aiUser, liveQuestion);

    expect(await claim(aiUser, liveQuestion)).toBe('claimed');
    expect(await usedToday(aiUser)).toBe(1);
    expect(await finish(aiUser, liveQuestion)).toBe(true);
  });

  it('refunds nothing when the same failure is reported twice', async () => {
    await claim(aiUser, liveQuestion);
    expect(await failCall(aiUser, liveQuestion)).toBe(true);
    // A second report finds no generating row, so there is nothing to give
    // back. Otherwise posting it in a loop would buy free calls.
    expect(await failCall(aiUser, liveQuestion)).toBe(false);
    expect(await usedToday(aiUser)).toBe(0);
  });
});

describe('finish_ai_explanation', () => {
  it('does nothing when no call is in flight', async () => {
    expect(await finish(aiUser, liveQuestion)).toBe(false);
    expect(await storedExplanation(liveQuestion)).toBeNull();
  });

  it('never overwrites a teacher-corrected explanation', async () => {
    await claim(aiUser, liveQuestion);
    await finish(aiUser, liveQuestion);

    await db.admin.query(
      `update public.ai_explanations
       set edited_by_teacher = true, body = '{"sections":[{"heading":"Fixed","body":"By the teacher"}]}'::jsonb
       where question_id = $1 and lang = 'en'`,
      [liveQuestion],
    );

    // A late reply from a retried call must not land on it.
    expect(await finish(aiUser, liveQuestion)).toBe(false);
    const row = await storedExplanation(liveQuestion);
    expect(row?.edited_by_teacher).toBe(true);
    expect(JSON.stringify(row?.body)).toContain('Fixed');
  });
});

describe('RLS', () => {
  it('a student cannot write the counter', async () => {
    await expect(
      db.asUser(aiUser, async (sql) => {
        await sql.query(
          `insert into public.ai_usage (user_id, ist_date, new_count)
           values ($1, public.ist_today(), 0)`,
          [aiUser],
        );
      }),
    ).rejects.toThrow();
  });

  it('a student cannot reset a counter the functions created', async () => {
    await claim(aiUser, liveQuestion);
    await db.asUser(aiUser, async (sql) => {
      await sql.query('update public.ai_usage set new_count = 0');
    });
    // No update policy, so the statement matches nothing.
    expect(await usedToday(aiUser)).toBe(1);
  });

  it('a student reads only their own counter', async () => {
    await claim(aiUser, liveQuestion);
    await claim(proUser, draftQuestion).catch(() => undefined);

    const rows = await db.asUser(aiUser, async (sql) => {
      const r = await sql.query<{ user_id: string }>('select user_id from public.ai_usage');
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(aiUser);
  });

  it('a student cannot insert an explanation by hand', async () => {
    await expect(
      db.asUser(aiUser, async (sql) => {
        await sql.query(
          `insert into public.ai_explanations (question_id, lang, status, body)
           values ($1, 'en', 'ready', $2::jsonb)`,
          [liveQuestion, BODY],
        );
      }),
    ).rejects.toThrow();
  });

  it('a student reads an explanation on a live question but not on a draft', async () => {
    await claim(aiUser, liveQuestion);
    await finish(aiUser, liveQuestion);
    // And one on the draft, written by its teacher.
    await claim(teacher, draftQuestion).catch(() => undefined);
    await db.admin.query(
      `insert into public.ai_explanations (question_id, lang, status, body)
       values ($1, 'en', 'ready', $2::jsonb)
       on conflict (question_id, lang) do update set status = 'ready', body = excluded.body`,
      [draftQuestion, BODY],
    );

    const seen = await db.asUser(aiUser, async (sql) => {
      const r = await sql.query<{ question_id: string }>(
        'select question_id from public.ai_explanations',
      );
      return r.rows.map((row) => row.question_id);
    });
    expect(seen).toEqual([liveQuestion]);
  });

  it('only the owning teacher may correct the text', async () => {
    await claim(aiUser, liveQuestion);
    await finish(aiUser, liveQuestion);

    // The student cannot: no update policy covers them.
    await db.asUser(aiUser, async (sql) => {
      await sql.query('update public.ai_explanations set edited_by_teacher = true');
    });
    expect((await storedExplanation(liveQuestion))?.edited_by_teacher).toBe(false);

    // The teacher who owns the question can.
    await db.asUser(teacher, async (sql) => {
      await sql.query('update public.ai_explanations set edited_by_teacher = true');
    });
    expect((await storedExplanation(liveQuestion))?.edited_by_teacher).toBe(true);
  });
});
