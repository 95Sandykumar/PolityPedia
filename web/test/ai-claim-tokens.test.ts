/**
 * A claim has an OWNER (issue 32-ai-claim-tokens).
 *
 * 0022 and 0025 decide who may start a model call, and they decide it well:
 * the primary key of `ai_explanations` is the race winner, so a question is
 * explained once. What neither file decided is who may END that call. Both
 * `finish_*` and `fail_*` only asked "is anybody signed in", and both are
 * SECURITY DEFINER and granted to `authenticated`, so any student could post
 * them over REST for somebody else's claim. Two things followed:
 *
 *   * COST. Claim through /api/revision, then call `fail_ai_explanation`
 *     yourself while the model is still writing. The count comes back, the
 *     row is released, and the 30-a-day cap never fills.
 *   * POISONING. Poll for a `generating` row and call
 *     `finish_ai_explanation` with your own text. It becomes the permanent
 *     saved explanation every student reads.
 *
 * This file proves the fix in Postgres, which is the only place it can live:
 * the gate has to hold for a REST call that never touches our route handler.
 *
 *  1. only the claimant may finish, fail, or finish the audio.
 *  2. a refund happens once, on a failure, and NEVER after a finish.
 *  3. a claim older than 2 minutes is taken over, and the first claimant is
 *     given their 1 of 30 back.
 *  4. a mock question needs test access, and an OPEN exam sitting on that
 *     test refuses the claim (the prompt quotes the correct option).
 *  5. a `javascript:` source is never stored.
 *  6. an audio path outside the explanation's own folder is refused.
 *
 * Seed with `db.admin` (bypasses RLS), act through `db.asUser` (Postgres
 * evaluates every policy and every `auth.uid()` for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the paper, the mock set and every question. */
let teacher: string;
/** The student who claims. On the AI plan. */
let userA: string;
/** The attacker: also on the AI plan, so only ownership can refuse them. */
let userB: string;

let liveQuestion: string;
/** A question inside a PAID mock test, so `has_test_access()` applies. */
let mockQuestion: string;
let mockSet: string;
let mockTest: string;

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
const GOOD_SOURCE = { title: 'India Code', url: 'https://www.indiacode.nic.in/' };

/** Where the audio for one explanation is allowed to live (`audio.ts`). */
function audioPath(questionId: string, lang = 'en'): string {
  return `explanations/${questionId}/${lang}.mp3`;
}

function claim(userId: string, questionId: string, lang = 'en'): Promise<string> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ code: string }>(
      'select public.claim_ai_explanation($1, $2) as code',
      [questionId, lang],
    );
    return r.rows[0].code;
  });
}

function finish(
  userId: string,
  questionId: string,
  sources: unknown[] = [GOOD_SOURCE],
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      `select public.finish_ai_explanation(
                $1, $2, $3::jsonb, $4::jsonb, 'claude-haiku-5-5', 900, 450, 2
              ) as saved`,
      [questionId, lang, BODY, JSON.stringify(sources)],
    );
    return r.rows[0].saved;
  });
}

function failCall(userId: string, questionId: string, lang = 'en'): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ gave_back: boolean }>(
      'select public.fail_ai_explanation($1, $2) as gave_back',
      [questionId, lang],
    );
    return r.rows[0].gave_back;
  });
}

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

interface StoredRow {
  status: string;
  sources: unknown;
  claimed_by: string | null;
  audio_status: string;
  audio_path: string | null;
  audio_claimed_by: string | null;
}

async function stored(questionId: string, lang = 'en'): Promise<StoredRow | null> {
  const r = await db.admin.query<StoredRow>(
    `select status, sources, claimed_by, audio_status, audio_path, audio_claimed_by
     from public.ai_explanations where question_id = $1 and lang = $2`,
    [questionId, lang],
  );
  return r.rows[0] ?? null;
}

async function usedToday(userId: string): Promise<number> {
  const r = await db.admin.query<{ new_count: number }>(
    'select new_count from public.ai_usage where user_id = $1 and ist_date = public.ist_today()',
    [userId],
  );
  return r.rows[0]?.new_count ?? 0;
}

/** Push a live claim into the past, so the takeover path is reachable. */
async function ageClaim(questionId: string, minutes = 3, lang = 'en'): Promise<void> {
  await db.admin.query(
    `update public.ai_explanations
     set claimed_at = now() - make_interval(mins => $3)
     where question_id = $1 and lang = $2`,
    [questionId, lang, minutes],
  );
}

async function ageAudioClaim(questionId: string, minutes = 3, lang = 'en'): Promise<void> {
  await db.admin.query(
    `update public.ai_explanations
     set audio_claimed_at = now() - make_interval(mins => $3)
     where question_id = $1 and lang = $2`,
    [questionId, lang, minutes],
  );
}

async function grant(userId: string, plan: 'ai' | 'pro'): Promise<void> {
  await db.admin.query(
    `insert into public.entitlements (user_id, plan, valid_until, source)
     values ($1, $2, now() + interval '30 days', 'admin')
     on conflict (user_id, plan) do update set valid_until = excluded.valid_until`,
    [userId, plan],
  );
}

/** Buy the mock set, the way issue 16 grants access. */
async function grantSet(userId: string): Promise<void> {
  await db.admin.query(
    `insert into public.set_access (user_id, set_id, source, valid_until)
     values ($1, $2, 'admin', now() + interval '30 days')
     on conflict (user_id, set_id, source) do update set valid_until = excluded.valid_until`,
    [userId, mockSet],
  );
}

/** A sitting that is still open, on the mock test. */
async function openExamSitting(userId: string): Promise<string> {
  const r = await db.admin.query<{ id: string }>(
    `insert into public.attempts (user_id, test_id, mode, deadline_at)
     values ($1, $2, 'exam', now() + interval '1 hour')
     returning id`,
    [userId, mockTest],
  );
  return r.rows[0].id;
}

/** One saved explanation with its audio unclaimed. */
async function seedReady(questionId: string, lang = 'en'): Promise<void> {
  await db.admin.query(
    `insert into public.ai_explanations (question_id, lang, status, body, sources, model)
     values ($1, $2, 'ready', $3::jsonb, '[]'::jsonb, 'claude-haiku-5-5')`,
    [questionId, lang, BODY],
  );
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  userA = await db.createUser();
  userB = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved')`,
    [teacher],
  );

  await grant(userA, 'ai');
  await grant(userB, 'ai');

  const paper = await db.admin.query<{ id: string }>(
    `insert into public.papers
       (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, 'Paper 1', 'papers/q.pdf', 'live')
     returning id`,
    [teacher, NET],
  );

  const set = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 299, 'live')
     returning id`,
    [teacher, NET],
  );
  mockSet = set.rows[0].id;

  const test = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, duration_min, is_free_sample)
     values ($1, 'Test 1', 1, 60, false)
     returning id`,
    [mockSet],
  );
  mockTest = test.rows[0].id;

  const live = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values ($1, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live')
     returning id`,
    [teacher, paper.rows[0].id, OPTIONS],
  );
  liveQuestion = live.rows[0].id;

  const mock = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, test_id, number, stem, options, correct_idx, checked, status)
     values ($1, $2, 1, 'Who appoints the Governor?', $3::jsonb, 0, true, 'live')
     returning id`,
    [teacher, mockTest, OPTIONS],
  );
  mockQuestion = mock.rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.ai_explanations');
  await db.admin.query('delete from public.ai_usage');
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.set_access');
});

describe('0032_ai_claim_tokens.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0032_ai_claim_tokens.sql');
  });

  it('writes the owner of a claim on the row', async () => {
    expect(await claim(userA, liveQuestion)).toBe('claimed');
    const row = await stored(liveQuestion);
    expect(row?.claimed_by).toBe(userA);
  });
});

describe('finish_ai_explanation: only the claimant', () => {
  it('refuses another student, so saved text cannot be poisoned', async () => {
    expect(await claim(userA, liveQuestion)).toBe('claimed');

    expect(await finish(userB, liveQuestion)).toBe(false);
    expect((await stored(liveQuestion))?.status).toBe('generating');

    // The one who paid for the call still can.
    expect(await finish(userA, liveQuestion)).toBe(true);
    expect((await stored(liveQuestion))?.status).toBe('ready');
  });

  it('never gives a call back, so a finish cannot be farmed', async () => {
    await claim(userA, liveQuestion);
    expect(await usedToday(userA)).toBe(1);

    expect(await finish(userA, liveQuestion)).toBe(true);
    expect(await usedToday(userA)).toBe(1);

    // A fail posted after the finish finds no generating row: no refund.
    expect(await failCall(userA, liveQuestion)).toBe(false);
    expect(await usedToday(userA)).toBe(1);
    expect((await stored(liveQuestion))?.status).toBe('ready');
  });
});

describe('fail_ai_explanation: only the claimant', () => {
  it('refuses another student, so the cap cannot be bypassed', async () => {
    expect(await claim(userA, liveQuestion)).toBe('claimed');
    expect(await usedToday(userA)).toBe(1);

    // The whole cost bypass: B refunds A's claim and A loops.
    expect(await failCall(userB, liveQuestion)).toBe(false);
    expect((await stored(liveQuestion))?.status).toBe('generating');
    expect(await usedToday(userA)).toBe(1);
    expect(await usedToday(userB)).toBe(0);
  });

  it('gives the claimant their own call back exactly once', async () => {
    await claim(userA, liveQuestion);
    expect(await failCall(userA, liveQuestion)).toBe(true);
    expect(await usedToday(userA)).toBe(0);
    expect(await failCall(userA, liveQuestion)).toBe(false);
    expect(await usedToday(userA)).toBe(0);
  });
});

describe('claim_ai_explanation: a stuck claim is taken over', () => {
  it('leaves a fresh claim alone', async () => {
    expect(await claim(userA, liveQuestion)).toBe('claimed');
    expect(await claim(userB, liveQuestion)).toBe('generating');
    expect(await usedToday(userB)).toBe(0);
    expect((await stored(liveQuestion))?.claimed_by).toBe(userA);
  });

  it('takes over a claim older than 2 minutes and refunds the first claimant', async () => {
    expect(await claim(userA, liveQuestion)).toBe('claimed');
    await ageClaim(liveQuestion);

    expect(await claim(userB, liveQuestion)).toBe('claimed');

    // A is not charged for a call that never came back; B is charged for theirs.
    expect(await usedToday(userA)).toBe(0);
    expect(await usedToday(userB)).toBe(1);
    expect((await stored(liveQuestion))?.claimed_by).toBe(userB);

    // A late reply from the first claimant must not land on B's claim.
    expect(await finish(userA, liveQuestion)).toBe(false);
    expect(await finish(userB, liveQuestion)).toBe(true);
    // The refund happened once: B's charge is still standing.
    expect(await usedToday(userA)).toBe(0);
    expect(await usedToday(userB)).toBe(1);
  });

  it('refuses the takeover when the new caller is at the cap', async () => {
    await claim(userA, liveQuestion);
    await ageClaim(liveQuestion);
    await db.admin.query(
      `insert into public.ai_usage (user_id, ist_date, new_count)
       values ($1, public.ist_today(), 30)`,
      [userB],
    );

    expect(await claim(userB, liveQuestion)).toBe('limit');
    // Nothing moved: A keeps the claim and nobody was refunded.
    expect((await stored(liveQuestion))?.claimed_by).toBe(userA);
    expect(await usedToday(userA)).toBe(1);
  });
});

describe('claim_ai_explanation: the mock paywall and the exam clock', () => {
  it('refuses a mock question the student has not unlocked', async () => {
    expect(await claim(userA, mockQuestion)).toBe('not_found');
    expect(await stored(mockQuestion)).toBeNull();
    expect(await usedToday(userA)).toBe(0);

    await grantSet(userA);
    expect(await claim(userA, mockQuestion)).toBe('claimed');
  });

  it('refuses while an exam sitting on that test is open', async () => {
    await grantSet(userA);
    const sitting = await openExamSitting(userA);

    // The prompt quotes the correct option, so an open sitting may not read it.
    expect(await claim(userA, mockQuestion)).toBe('not_found');
    expect(await stored(mockQuestion)).toBeNull();

    await db.admin.query('update public.attempts set submitted_at = now() where id = $1', [
      sitting,
    ]);
    expect(await claim(userA, mockQuestion)).toBe('claimed');
  });

  it('leaves another student and practice mode alone', async () => {
    await grantSet(userA);
    await grantSet(userB);
    await openExamSitting(userB);

    // B's sitting is B's problem.
    expect(await claim(userA, mockQuestion)).toBe('claimed');
    await finish(userA, mockQuestion);

    await db.admin.query('delete from public.attempts');
    await db.admin.query(
      `insert into public.attempts (user_id, test_id, mode) values ($1, $2, 'practice')`,
      [userB, mockTest],
    );
    // Practice mode shows the answer anyway, so Revision stays open.
    expect(await claim(userB, mockQuestion)).toBe('ready');
  });
});

describe('sources: only http and https are stored', () => {
  it('drops a javascript: source and keeps the real one', async () => {
    await claim(userA, liveQuestion);
    expect(
      await finish(userA, liveQuestion, [
        { title: 'Free marks', url: 'javascript:alert(1)' },
        GOOD_SOURCE,
        { title: 'Phish', url: 'data:text/html,<script>1</script>' },
        { title: 'No url at all' },
      ]),
    ).toBe(true);

    const kept = (await stored(liveQuestion))?.sources as { url: string }[];
    expect(kept.map((s) => s.url)).toEqual([GOOD_SOURCE.url]);
  });

  it('refuses a stored javascript: source outright', async () => {
    await claim(userA, liveQuestion);
    await finish(userA, liveQuestion);
    await expect(
      db.admin.query(
        `update public.ai_explanations
         set sources = '[{"title":"x","url":"javascript:alert(1)"}]'::jsonb
         where question_id = $1 and lang = 'en'`,
        [liveQuestion],
      ),
    ).rejects.toThrow();
  });
});

describe('explanation audio: only the claimant, only its own folder', () => {
  it('refuses a finish and a fail from another student', async () => {
    await seedReady(liveQuestion);
    expect(await claimAudio(userA, liveQuestion)).toBe('claimed');
    expect((await stored(liveQuestion))?.audio_claimed_by).toBe(userA);

    expect(await finishAudio(userB, liveQuestion)).toBe(false);
    expect(await failAudio(userB, liveQuestion)).toBe(false);
    expect((await stored(liveQuestion))?.audio_status).toBe('making');

    expect(await finishAudio(userA, liveQuestion)).toBe(true);
    const row = await stored(liveQuestion);
    expect(row?.audio_status).toBe('ready');
    expect(row?.audio_path).toBe(audioPath(liveQuestion));
  });

  it('refuses a path outside the explanation folder', async () => {
    await seedReady(liveQuestion);
    await claimAudio(userA, liveQuestion);

    expect(await finishAudio(userA, liveQuestion, 'explanations/one/en.mp3')).toBe(false);
    expect(
      await finishAudio(userA, liveQuestion, `explanations/${liveQuestion}/../x/en.mp3`),
    ).toBe(false);
    expect((await stored(liveQuestion))?.audio_status).toBe('making');

    expect(await finishAudio(userA, liveQuestion)).toBe(true);
  });

  it('takes over an audio claim older than 2 minutes', async () => {
    await seedReady(liveQuestion);
    expect(await claimAudio(userA, liveQuestion)).toBe('claimed');
    expect(await claimAudio(userB, liveQuestion)).toBe('making');

    await ageAudioClaim(liveQuestion);
    expect(await claimAudio(userB, liveQuestion)).toBe('claimed');
    expect((await stored(liveQuestion))?.audio_claimed_by).toBe(userB);

    // The first caller's late upload is refused.
    expect(await finishAudio(userA, liveQuestion)).toBe(false);
    expect(await finishAudio(userB, liveQuestion)).toBe(true);
  });
});
