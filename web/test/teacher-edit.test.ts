/**
 * A teacher corrects the AI explanation of their OWN question
 * (issue 24-revision-teacher-edit).
 *
 * F7 is the human gate on AI text, and F-F4 says the teacher is the one who
 * may close it. That rule cannot live in a route handler: a route handler can
 * be called with any `question_id`, and a second route handler can be running
 * at the same moment on another machine. It lives in Postgres, and this file
 * proves it there:
 *
 *  1. teacher A edits the explanation of their own question    -> saved.
 *  2. the save sets `edited_by_teacher` -> it is not optional, it is required.
 *  3. teacher B edits teacher A's question's explanation       -> 0 rows.
 *  4. a student edits anything                                 -> 0 rows.
 *  5. a student then READS the edited body                     -> the new text.
 *  6. a teacher edit cannot move the row, change its status, or rewrite the
 *     cost columns, so an edit can never look like a fresh AI call.
 *
 * Seed with `db.admin` (bypasses RLS), assert through `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the paper and both questions. */
let teacherA: string;
/** A second approved teacher. Owns nothing in this file. */
let teacherB: string;
/** Any signed-in student. Reads, never writes. */
let student: string;

let paper: string;
/** A published question every student may read. */
let liveQuestion: string;
/** Teacher A's draft. Only teacher A may reach it. */
let draftQuestion: string;

/** One exam from the 0004 seed, by its fixed id. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

/** What the model wrote. */
const AI_BODY = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'The Lok Sabha.' }],
  remember: 'Lok Sabha = Council of States.',
};

/** What the teacher corrects it to. The AI had the house wrong. */
const FIXED_BODY = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [
    { heading: 'Answer', body: 'The Rajya Sabha. Article 80 names it the Council of States.' },
  ],
  remember: 'Rajya Sabha = Council of States.',
};

const SOURCES = JSON.stringify([{ title: 'India Code', url: 'https://www.indiacode.nic.in/' }]);

interface StoredRow {
  status: string;
  body: typeof AI_BODY | null;
  sources: unknown;
  audio_path: string | null;
  edited_by_teacher: boolean;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  searches: number | null;
}

/** Put one READY AI explanation on a question, the way issue 22 does. */
async function seedExplanation(questionId: string, lang = 'en', audioPath: string | null = null) {
  await db.admin.query(
    `insert into public.ai_explanations
       (question_id, lang, status, body, sources, audio_path,
        model, tokens_in, tokens_out, searches)
     values ($1, $2, 'ready', $3::jsonb, $4::jsonb, $5,
             'claude-haiku-5-5', 900, 450, 2)`,
    [questionId, lang, JSON.stringify(AI_BODY), SOURCES, audioPath],
  );
}

/** Read the stored row with the owner handle, so RLS never hides it. */
async function stored(questionId: string, lang = 'en'): Promise<StoredRow | null> {
  const r = await db.admin.query<StoredRow>(
    `select status, body, sources, audio_path, edited_by_teacher,
            model, tokens_in, tokens_out, searches
     from public.ai_explanations where question_id = $1 and lang = $2`,
    [questionId, lang],
  );
  return r.rows[0] ?? null;
}

/**
 * The edit exactly as the app sends it: new body, and the flag set to true.
 * Returns how many rows the policy let through.
 */
function edit(
  userId: string,
  questionId: string,
  body: unknown = FIXED_BODY,
  lang = 'en',
): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query(
      `update public.ai_explanations
          set body = $1::jsonb, edited_by_teacher = true
        where question_id = $2 and lang = $3`,
      [JSON.stringify(body), questionId, lang],
    );
    return r.affectedRows ?? 0;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  teacherB = await db.createUser();
  student = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved'),
            ($2, 'alias', 'Other Guru', 'approved')`,
    [teacherA, teacherB],
  );

  const p = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Paper 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacherA, NET],
  );
  paper = p.rows[0].id;

  const made = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values
       ($1, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live'),
       ($1, $2, 2, 'Who appoints the Governor?', $3::jsonb, 0, false, 'draft')
     returning id`,
    [teacherA, paper, OPTIONS],
  );
  liveQuestion = made.rows[0].id;
  draftQuestion = made.rows[1].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.ai_explanations');
});

describe('0024_teacher_edit.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0024_teacher_edit.sql');
  });
});

describe('the question owner may correct the text', () => {
  it('saves teacher A the new body on their own live question', async () => {
    await seedExplanation(liveQuestion);

    expect(await edit(teacherA, liveQuestion)).toBe(1);

    const row = await stored(liveQuestion);
    expect(row?.body?.sections[0].body).toContain('Rajya Sabha');
    expect(row?.body?.remember).toBe('Rajya Sabha = Council of States.');
  });

  it('works on their own DRAFT question too', async () => {
    await seedExplanation(draftQuestion);
    expect(await edit(teacherA, draftQuestion)).toBe(1);
    expect((await stored(draftQuestion))?.edited_by_teacher).toBe(true);
  });

  it('edits the Hindi row without touching the English one', async () => {
    await seedExplanation(liveQuestion, 'en');
    await seedExplanation(liveQuestion, 'hi');

    expect(await edit(teacherA, liveQuestion, FIXED_BODY, 'hi')).toBe(1);

    expect((await stored(liveQuestion, 'hi'))?.edited_by_teacher).toBe(true);
    expect((await stored(liveQuestion, 'en'))?.edited_by_teacher).toBe(false);
  });
});

describe('edited_by_teacher is required, not optional', () => {
  it('marks the row, so the UI can stop calling it AI', async () => {
    await seedExplanation(liveQuestion);
    expect((await stored(liveQuestion))?.edited_by_teacher).toBe(false);

    await edit(teacherA, liveQuestion);

    expect((await stored(liveQuestion))?.edited_by_teacher).toBe(true);
  });

  it('refuses an edit that leaves the flag false', async () => {
    await seedExplanation(liveQuestion);

    await expect(
      db.asUser(teacherA, (sql) =>
        sql.query(
          `update public.ai_explanations set body = $1::jsonb
            where question_id = $2 and lang = 'en'`,
          [JSON.stringify(FIXED_BODY), liveQuestion],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // Nothing moved: the AI text is still the stored one.
    const row = await stored(liveQuestion);
    expect(row?.edited_by_teacher).toBe(false);
    expect(row?.body?.sections[0].body).toBe('The Lok Sabha.');
  });

  it('refuses an edited row with no sections to render', async () => {
    await seedExplanation(liveQuestion);

    await expect(edit(teacherA, liveQuestion, { sections: [] })).rejects.toThrow();
    await expect(edit(teacherA, liveQuestion, { remember: 'nothing' })).rejects.toThrow();

    expect((await stored(liveQuestion))?.edited_by_teacher).toBe(false);
  });
});

describe('nobody else may correct the text', () => {
  it('lets teacher B change nothing on teacher A question', async () => {
    await seedExplanation(liveQuestion);

    expect(await edit(teacherB, liveQuestion)).toBe(0);

    const row = await stored(liveQuestion);
    expect(row?.edited_by_teacher).toBe(false);
    expect(row?.body?.sections[0].body).toBe('The Lok Sabha.');
  });

  it('lets a student change nothing', async () => {
    await seedExplanation(liveQuestion);

    expect(await edit(student, liveQuestion)).toBe(0);
    expect((await stored(liveQuestion))?.edited_by_teacher).toBe(false);
  });

  it('lets a visitor who is not signed in change nothing', async () => {
    await seedExplanation(liveQuestion);

    const rows = await db.asAnon(async (sql) => {
      const r = await sql.query(
        `update public.ai_explanations set body = $1::jsonb, edited_by_teacher = true
          where question_id = $2 and lang = 'en'`,
        [JSON.stringify(FIXED_BODY), liveQuestion],
      );
      return r.affectedRows ?? 0;
    });

    expect(rows).toBe(0);
    expect((await stored(liveQuestion))?.edited_by_teacher).toBe(false);
  });
});

describe('students then read the edited version', () => {
  it('serves the corrected body to a signed-in student', async () => {
    await seedExplanation(liveQuestion);
    await edit(teacherA, liveQuestion);

    const rows = await db.asUser(student, async (sql) => {
      const r = await sql.query<{ body: typeof AI_BODY; edited_by_teacher: boolean }>(
        `select body, edited_by_teacher from public.ai_explanations
          where question_id = $1 and lang = 'en'`,
        [liveQuestion],
      );
      return r.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].body.sections[0].body).toContain('Rajya Sabha');
    expect(rows[0].edited_by_teacher).toBe(true);
  });

  it('still hides a draft question explanation from a student', async () => {
    await seedExplanation(draftQuestion);
    await edit(teacherA, draftQuestion);

    const rows = await db.asUser(student, async (sql) => {
      const r = await sql.query(
        'select body from public.ai_explanations where question_id = $1',
        [draftQuestion],
      );
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });
});

describe('an edit cannot pretend to be an AI call', () => {
  it('keeps the model and the cost columns exactly as the call left them', async () => {
    await seedExplanation(liveQuestion);

    await db.asUser(teacherA, (sql) =>
      sql.query(
        `update public.ai_explanations
            set body = $1::jsonb, edited_by_teacher = true,
                model = 'gpt-cheat', tokens_in = 0, tokens_out = 0, searches = 0
          where question_id = $2 and lang = 'en'`,
        [JSON.stringify(FIXED_BODY), liveQuestion],
      ),
    );

    const row = await stored(liveQuestion);
    expect(row?.model).toBe('claude-haiku-5-5');
    expect(row?.tokens_in).toBe(900);
    expect(row?.tokens_out).toBe(450);
    expect(row?.searches).toBe(2);
  });

  it('leaves the row ready, so a retry cannot overwrite the correction', async () => {
    await seedExplanation(liveQuestion);

    await db.asUser(teacherA, (sql) =>
      sql.query(
        `update public.ai_explanations
            set body = $1::jsonb, edited_by_teacher = true, status = 'generating'
          where question_id = $2 and lang = 'en'`,
        [JSON.stringify(FIXED_BODY), liveQuestion],
      ),
    );

    expect((await stored(liveQuestion))?.status).toBe('ready');

    // The AI finish path now saves nothing, because no row is generating.
    //
    // Posted as OUR SERVER (`db.asService`), because issue
    // 41-ai-finish-server-only granted this function to `service_role` alone.
    // The eight-argument shape with no secret is still accepted and still
    // refused, which is the fail-closed promise from issue 37.
    const saved = await db.asService(async (sql) => {
      const r = await sql.query<{ saved: boolean }>(
        `select public.finish_ai_explanation(
                  $1, 'en', $2::jsonb, '[]'::jsonb, 'claude-haiku-5-5', 1, 1, 0
                ) as saved`,
        [liveQuestion, JSON.stringify(AI_BODY)],
      );
      return r.rows[0].saved;
    });

    expect(saved).toBe(false);
    expect((await stored(liveQuestion))?.body?.sections[0].body).toContain('Rajya Sabha');
  });

  it('cannot hand the explanation to another question or language', async () => {
    await seedExplanation(liveQuestion);

    await db.asUser(teacherA, (sql) =>
      sql.query(
        `update public.ai_explanations
            set body = $1::jsonb, edited_by_teacher = true,
                question_id = $2, lang = 'hi'
          where question_id = $3 and lang = 'en'`,
        [JSON.stringify(FIXED_BODY), draftQuestion, liveQuestion],
      ),
    );

    // The row is still where it was, and no row appeared on the draft.
    expect((await stored(liveQuestion))?.edited_by_teacher).toBe(true);
    expect(await stored(draftQuestion)).toBeNull();
    expect(await stored(liveQuestion, 'hi')).toBeNull();
  });

  it('drops stale audio when the text changes, so issue 25 regenerates it', async () => {
    await seedExplanation(liveQuestion, 'en', 'audio/old.mp3');

    await edit(teacherA, liveQuestion);

    expect((await stored(liveQuestion))?.audio_path).toBeNull();
  });
});
