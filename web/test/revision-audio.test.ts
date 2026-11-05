/**
 * Revision audio: made once, saved (issue 25-revision-audio).
 *
 * F-F5 is "a paid AI voice, Hindi and English, MADE ONCE and saved". The
 * explanation itself is already made once by the primary key of
 * `ai_explanations` (0022). The audio needs the same promise, for the same
 * reason: a paid voice is charged per character, and two students opening the
 * same explanation at the same instant must not both pay for the same words.
 *
 * So the race is decided in Postgres again, this time by an UPDATE that only
 * matches a row whose audio nobody has claimed yet. `row_count` says who won.
 * No lock, no queue, nothing that dies with a serverless process.
 *
 * What this file proves:
 *
 *  1. a ready explanation with no audio  -> `claimed` once, `making` after.
 *  2. still generating                   -> `not_ready`, nothing is claimed.
 *  3. no row / a draft question          -> `not_found`.
 *  4. finish                             -> `audio_path` set, status `ready`.
 *  5. a second claim after finish        -> `ready`, so never a second call.
 *  6. a failure                          -> `failed`, and a retry may claim.
 *  7. English and Hindi                  -> two separate claims (F-F5).
 *  8. a student cannot write `audio_path` directly.
 *
 * Seed with `db.admin` (bypasses RLS), assert through `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

let teacher: string;
let student: string;
let other: string;

let liveQuestion: string;
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

/**
 * Where the audio for one explanation is allowed to live.
 *
 * `explanationAudioPath()` in `src/lib/ai/audio.ts` builds exactly this, and
 * since issue 32-ai-claim-tokens `finish_explanation_audio()` refuses
 * anything outside the explanation's own folder.
 */
function audioPath(questionId: string, lang = 'en'): string {
  return `explanations/${questionId}/${lang}.mp3`;
}

interface AudioRow {
  status: string;
  audio_status: string;
  audio_path: string | null;
}

/** Call the gate the way the background step does: as a signed-in student. */
function claimAudio(userId: string, questionId: string, lang = 'en'): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ code: string }>(
      'select public.claim_explanation_audio($1, $2) as code',
      [questionId, lang],
    );
    return r.rows[0].code;
  });
}

function finishAudio(
  userId: string,
  questionId: string,
  path?: string,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      'select public.finish_explanation_audio($1, $2, $3) as saved',
      [questionId, lang, path ?? audioPath(questionId, lang)],
    );
    return r.rows[0].saved;
  });
}

function failAudio(userId: string, questionId: string, lang = 'en'): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ released: boolean }>(
      'select public.fail_explanation_audio($1, $2) as released',
      [questionId, lang],
    );
    return r.rows[0].released;
  });
}

async function storedAudio(questionId: string, lang = 'en'): Promise<AudioRow | null> {
  const r = await db.admin.query<AudioRow>(
    `select status, audio_status, audio_path
     from public.ai_explanations where question_id = $1 and lang = $2`,
    [questionId, lang],
  );
  return r.rows[0] ?? null;
}

/** Seed one saved explanation, the way `finish_ai_explanation` leaves it. */
async function seedExplanation(
  questionId: string,
  lang = 'en',
  status = 'ready',
): Promise<void> {
  await db.admin.query(
    `insert into public.ai_explanations (question_id, lang, status, body, sources, model)
     values ($1, $2, $3, case when $3 = 'ready' then $4::jsonb else null end,
             '[]'::jsonb, 'claude-haiku-5-5')`,
    [questionId, lang, status, BODY],
  );
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

  const p = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Paper 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacher, NET],
  );

  const made = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values
       ($1, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live'),
       ($1, $2, 2, 'Who appoints the Governor?', $3::jsonb, 0, false, 'draft')
     returning id`,
    [teacher, p.rows[0].id, OPTIONS],
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

describe('0025_revision_audio.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0025_revision_audio.sql');
  });

  it('starts every explanation with no audio', async () => {
    await seedExplanation(liveQuestion);
    const row = await storedAudio(liveQuestion);
    expect(row?.audio_status).toBe('none');
    expect(row?.audio_path).toBeNull();
  });

  it('refuses a ready audio_status with no path', async () => {
    await seedExplanation(liveQuestion);
    await expect(
      db.admin.query(
        `update public.ai_explanations set audio_status = 'ready'
         where question_id = $1 and lang = 'en'`,
        [liveQuestion],
      ),
    ).rejects.toThrow();
  });
});

describe('claim_explanation_audio: made once', () => {
  it('lets exactly one caller claim it, even when two arrive together', async () => {
    await seedExplanation(liveQuestion);

    const [first, second] = await Promise.all([
      claimAudio(student, liveQuestion),
      claimAudio(other, liveQuestion),
    ]);

    // One `claimed`, one told somebody else is on it. Never two `claimed`:
    // that is the whole point of F-F5 and of this test.
    expect([first, second].filter((code) => code === 'claimed')).toHaveLength(1);
    expect([first, second].filter((code) => code === 'making')).toHaveLength(1);
    expect((await storedAudio(liveQuestion))?.audio_status).toBe('making');
  });

  it('refuses while the explanation itself is still being written', async () => {
    await seedExplanation(liveQuestion, 'en', 'generating');
    expect(await claimAudio(student, liveQuestion)).toBe('not_ready');
    expect((await storedAudio(liveQuestion))?.audio_status).toBe('none');
  });

  it('refuses when there is no explanation at all', async () => {
    expect(await claimAudio(student, liveQuestion)).toBe('not_found');
  });

  it('refuses a question the caller may not read', async () => {
    await seedExplanation(draftQuestion);
    expect(await claimAudio(student, draftQuestion)).toBe('not_found');
    // Its own teacher may, because they can read their own draft.
    expect(await claimAudio(teacher, draftQuestion)).toBe('claimed');
  });

  it('claims English and Hindi separately', async () => {
    await seedExplanation(liveQuestion, 'en');
    await seedExplanation(liveQuestion, 'hi');

    expect(await claimAudio(student, liveQuestion, 'en')).toBe('claimed');
    expect(await claimAudio(student, liveQuestion, 'hi')).toBe('claimed');
    expect((await storedAudio(liveQuestion, 'en'))?.audio_status).toBe('making');
    expect((await storedAudio(liveQuestion, 'hi'))?.audio_status).toBe('making');
  });
});

describe('finish_explanation_audio: saved once and reused', () => {
  it('stores the path and never hands out a second claim', async () => {
    await seedExplanation(liveQuestion);
    expect(await claimAudio(student, liveQuestion)).toBe('claimed');
    expect(await finishAudio(student, liveQuestion)).toBe(true);

    const row = await storedAudio(liveQuestion);
    expect(row?.audio_path).toBe(audioPath(liveQuestion));
    expect(row?.audio_status).toBe('ready');

    // The second student opening the same explanation makes no audio.
    expect(await claimAudio(other, liveQuestion)).toBe('ready');
  });

  it('saves nothing when nobody claimed it', async () => {
    await seedExplanation(liveQuestion);
    expect(await finishAudio(student, liveQuestion)).toBe(false);
    expect((await storedAudio(liveQuestion))?.audio_path).toBeNull();
  });

  it('refuses an empty path, so a ready row always has audio', async () => {
    await seedExplanation(liveQuestion);
    await claimAudio(student, liveQuestion);
    expect(await finishAudio(student, liveQuestion, '   ')).toBe(false);
    expect((await storedAudio(liveQuestion))?.audio_status).toBe('making');
  });
});

describe('fail_explanation_audio: a broken call may be retried', () => {
  it('releases the row and lets the next caller claim it', async () => {
    await seedExplanation(liveQuestion);
    expect(await claimAudio(student, liveQuestion)).toBe('claimed');

    expect(await failAudio(student, liveQuestion)).toBe(true);
    expect((await storedAudio(liveQuestion))?.audio_status).toBe('failed');

    expect(await claimAudio(other, liveQuestion)).toBe('claimed');
  });

  it('releases nothing when no call was in flight', async () => {
    await seedExplanation(liveQuestion);
    expect(await failAudio(student, liveQuestion)).toBe(false);
  });
});

describe('RLS', () => {
  it('does not let a student write audio_path directly', async () => {
    await seedExplanation(liveQuestion);

    const changed = await db.asUser(student, async (sql) => {
      const r = await sql.query(
        `update public.ai_explanations set audio_path = 'explanations/hack.mp3'
         where question_id = $1 and lang = 'en'`,
        [liveQuestion],
      );
      return r.affectedRows ?? 0;
    });

    expect(changed).toBe(0);
    expect((await storedAudio(liveQuestion))?.audio_path).toBeNull();
  });
});
