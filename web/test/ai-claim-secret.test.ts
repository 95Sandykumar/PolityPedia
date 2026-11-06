/**
 * A CLAIM CARRIES A SECRET (issue 37-ai-claim-secret).
 *
 * Issue 32 keyed `finish_*` and `fail_*` on `claimed_by = auth.uid()`, which
 * stopped ANOTHER student from ending somebody else's call. It did not stop
 * the CLAIMANT, and the claimant is who the money hole needs:
 *
 *   The app has no service-role key. Every Supabase call carries the
 *   STUDENT'S OWN access token, so `claimed_by = auth.uid()` is true for the
 *   student's own browser as well as for our route handler. The student
 *   claims through /api/revision, and then, while our server is waiting on
 *   Claude, posts `rpc/fail_ai_explanation` from the browser. The row is
 *   released and the 1 of 30 comes back. Claim, fail, claim: three cycles,
 *   three Claude calls, a daily count that never leaves 0.
 *
 * The fix is a one-time SECRET that only the call which CREATED or TOOK OVER
 * the claim is ever told. Our route keeps it in server memory for the length
 * of one model call. `finish_*` and `fail_*` need it, besides `claimed_by`.
 * The browser can claim over REST and will be handed a secret, but that claim
 * makes no model call, so it buys the attacker nothing.
 *
 * Only the HASH is stored, so the row the student is allowed to read tells
 * them nothing. A v4 uuid is 122 random bits; guessing one is not a strategy.
 *
 * Also here, because it is the same row: the TAKEOVER REFUND RACE. 0032 read
 * the stale row with no lock, so the first claimant's own `fail`, landing
 * between that read and the upsert, was refunded twice. The authoritative
 * read is now `select ... for update`.
 *
 * Seed with `db.admin` (bypasses RLS), act through `db.asUser` (Postgres
 * evaluates every policy and every `auth.uid()` for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the paper and the question. */
let teacher: string;
/** The student who claims. On the AI plan. */
let userA: string;
/** A second student, also on the AI plan, so only the claim can refuse them. */
let userB: string;

let liveQuestion: string;

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

/** A secret that was never issued. Shaped right, so only the hash refuses it. */
const WRONG_SECRET = '11111111-2222-4333-8444-555555555555';

/** What `claim_ai_explanation()` now answers with. */
interface ClaimOutcome {
  code: string;
  secret: string | null;
}

function audioPath(questionId: string, lang = 'en'): string {
  return `explanations/${questionId}/${lang}.mp3`;
}

function readOutcome(value: unknown): ClaimOutcome {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    code: typeof raw.code === 'string' ? raw.code : '',
    secret: typeof raw.secret === 'string' ? raw.secret : null,
  };
}

function claim(userId: string, questionId: string, lang = 'en'): Promise<ClaimOutcome> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ out: unknown }>(
      'select public.claim_ai_explanation($1, $2) as out',
      [questionId, lang],
    );
    return readOutcome(r.rows[0].out);
  });
}

function finish(
  userId: string,
  questionId: string,
  secret: string | null,
  sources: unknown[] = [GOOD_SOURCE],
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      `select public.finish_ai_explanation(
                $1, $2, $3::jsonb, $4::jsonb, 'claude-haiku-5-5', 900, 450, 2, $5::uuid
              ) as saved`,
      [questionId, lang, BODY, JSON.stringify(sources), secret],
    );
    return r.rows[0].saved;
  });
}

/** The 8-argument shape a pre-37 caller posts. No secret at all. */
function finishWithNoSecretArgument(
  userId: string,
  questionId: string,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      `select public.finish_ai_explanation(
                $1, $2, $3::jsonb, '[]'::jsonb, 'claude-haiku-5-5', 900, 450, 2
              ) as saved`,
      [questionId, lang, BODY],
    );
    return r.rows[0].saved;
  });
}

function failCall(
  userId: string,
  questionId: string,
  secret: string | null,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ gave_back: boolean }>(
      'select public.fail_ai_explanation($1, $2, $3::uuid) as gave_back',
      [questionId, lang, secret],
    );
    return r.rows[0].gave_back;
  });
}

/** The 2-argument shape a pre-37 caller posts. No secret at all. */
function failWithNoSecretArgument(
  userId: string,
  questionId: string,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ gave_back: boolean }>(
      'select public.fail_ai_explanation($1, $2) as gave_back',
      [questionId, lang],
    );
    return r.rows[0].gave_back;
  });
}

function claimAudio(userId: string, questionId: string, lang = 'en'): Promise<ClaimOutcome> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ out: unknown }>(
      'select public.claim_explanation_audio($1, $2) as out',
      [questionId, lang],
    );
    return readOutcome(r.rows[0].out);
  });
}

function finishAudio(
  userId: string,
  questionId: string,
  secret: string | null,
  path?: string,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      'select public.finish_explanation_audio($1, $2, $3, $4::uuid) as saved',
      [questionId, lang, path ?? audioPath(questionId, lang), secret],
    );
    return r.rows[0].saved;
  });
}

function failAudio(
  userId: string,
  questionId: string,
  secret: string | null,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ released: boolean }>(
      'select public.fail_explanation_audio($1, $2, $3::uuid) as released',
      [questionId, lang, secret],
    );
    return r.rows[0].released;
  });
}

/** The 3-argument shape a pre-37 caller posts for the audio. */
function finishAudioWithNoSecretArgument(
  userId: string,
  questionId: string,
  lang = 'en',
): Promise<boolean> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ saved: boolean }>(
      'select public.finish_explanation_audio($1, $2, $3) as saved',
      [questionId, lang, audioPath(questionId, lang)],
    );
    return r.rows[0].saved;
  });
}

function failAudioWithNoSecretArgument(
  userId: string,
  questionId: string,
  lang = 'en',
): Promise<boolean> {
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
  claimed_by: string | null;
  claim_secret_hash: string | null;
  audio_status: string;
  audio_path: string | null;
  audio_claimed_by: string | null;
  audio_claim_secret_hash: string | null;
}

async function stored(questionId: string, lang = 'en'): Promise<StoredRow | null> {
  const r = await db.admin.query<StoredRow>(
    `select status, claimed_by, claim_secret_hash,
            audio_status, audio_path, audio_claimed_by, audio_claim_secret_hash
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

  const live = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, number, stem, options, correct_idx, checked, status)
     values ($1, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live')
     returning id`,
    [teacher, paper.rows[0].id, OPTIONS],
  );
  liveQuestion = live.rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.ai_explanations');
  await db.admin.query('delete from public.ai_usage');
  await db.admin.query('delete from public.attempts');
});

describe('0038_ai_claim_secret.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0038_ai_claim_secret.sql');
  });

  it('hands a secret to the call that created the claim, and only that call', async () => {
    const first = await claim(userA, liveQuestion);
    expect(first.code).toBe('claimed');
    expect(first.secret).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // THE SAME STUDENT asking again is told to wait, and told nothing else.
    // This is what makes a browser-side claim worthless: our route sees
    // `generating`, makes no model call, and spends no money.
    const again = await claim(userA, liveQuestion);
    expect(again.code).toBe('generating');
    expect(again.secret).toBeNull();

    const other = await claim(userB, liveQuestion);
    expect(other.code).toBe('generating');
    expect(other.secret).toBeNull();
  });

  it('stores only a hash, so the row the student may read gives nothing away', async () => {
    const { secret } = await claim(userA, liveQuestion);
    const row = await stored(liveQuestion);

    expect(row?.claim_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.claim_secret_hash).not.toBe(secret);

    // The student CAN read their own generating row (policy from 0022). What
    // they get is the hash, which is not the secret and cannot be posted as
    // one.
    const seen = await db.asUser(userA, async (sql) => {
      const r = await sql.query<{ claim_secret_hash: string | null }>(
        `select claim_secret_hash from public.ai_explanations
         where question_id = $1 and lang = 'en'`,
        [liveQuestion],
      );
      return r.rows[0]?.claim_secret_hash ?? null;
    });
    expect(seen).toBe(row?.claim_secret_hash);
    expect(seen).not.toBe(secret);
  });

  it('answers a free read with no secret at all', async () => {
    await seedReady(liveQuestion);
    const outcome = await claim(userA, liveQuestion);
    expect(outcome.code).toBe('ready');
    expect(outcome.secret).toBeNull();
  });
});

describe('fail_ai_explanation: the refund needs the secret', () => {
  it('refuses the claimant with no secret, so the claim-fail-claim loop is dead', async () => {
    const { secret } = await claim(userA, liveQuestion);
    expect(secret).not.toBeNull();
    expect(await usedToday(userA)).toBe(1);

    // THE WHOLE COST HOLE, posted from the browser three times over.
    for (let i = 0; i < 3; i += 1) {
      expect(await failWithNoSecretArgument(userA, liveQuestion)).toBe(false);
      expect(await failCall(userA, liveQuestion, null)).toBe(false);
      expect(await failCall(userA, liveQuestion, WRONG_SECRET)).toBe(false);

      // The row never moved, so a re-claim is "wait", not a second call.
      expect((await stored(liveQuestion))?.status).toBe('generating');
      const retry = await claim(userA, liveQuestion);
      expect(retry.code).toBe('generating');
      expect(retry.secret).toBeNull();
    }

    // One claim, one charge. Three cycles bought nothing.
    expect(await usedToday(userA)).toBe(1);
  });

  it('refunds once with the right secret, and never again', async () => {
    const { secret } = await claim(userA, liveQuestion);
    expect(await usedToday(userA)).toBe(1);

    expect(await failCall(userA, liveQuestion, secret)).toBe(true);
    expect(await usedToday(userA)).toBe(0);
    expect((await stored(liveQuestion))?.status).toBe('failed');

    // Replaying the same secret finds no generating row AND no stored hash.
    expect(await failCall(userA, liveQuestion, secret)).toBe(false);
    expect(await usedToday(userA)).toBe(0);
    expect((await stored(liveQuestion))?.claim_secret_hash).toBeNull();
  });

  it('still refuses another student holding the right secret', async () => {
    const { secret } = await claim(userA, liveQuestion);

    // Belt and braces: the owner check from issue 32 is still there.
    expect(await failCall(userB, liveQuestion, secret)).toBe(false);
    expect(await usedToday(userA)).toBe(1);
    expect(await usedToday(userB)).toBe(0);
  });
});

describe('finish_ai_explanation: the save needs the secret', () => {
  it('refuses a wrong secret and a missing one', async () => {
    const { secret } = await claim(userA, liveQuestion);

    expect(await finishWithNoSecretArgument(userA, liveQuestion)).toBe(false);
    expect(await finish(userA, liveQuestion, null)).toBe(false);
    expect(await finish(userA, liveQuestion, WRONG_SECRET)).toBe(false);
    expect((await stored(liveQuestion))?.status).toBe('generating');

    expect(await finish(userA, liveQuestion, secret)).toBe(true);
    expect((await stored(liveQuestion))?.status).toBe('ready');
  });

  it('never refunds, so a finish cannot be farmed', async () => {
    const { secret } = await claim(userA, liveQuestion);
    expect(await finish(userA, liveQuestion, secret)).toBe(true);
    expect(await usedToday(userA)).toBe(1);

    expect(await failCall(userA, liveQuestion, secret)).toBe(false);
    expect(await usedToday(userA)).toBe(1);
  });
});

describe('claim_ai_explanation: a takeover kills the old secret', () => {
  it('refunds the first claimant exactly once and locks their secret out', async () => {
    const first = await claim(userA, liveQuestion);
    expect(first.code).toBe('claimed');
    await ageClaim(liveQuestion);

    const second = await claim(userB, liveQuestion);
    expect(second.code).toBe('claimed');
    expect(second.secret).not.toBeNull();
    expect(second.secret).not.toBe(first.secret);

    expect(await usedToday(userA)).toBe(0);
    expect(await usedToday(userB)).toBe(1);

    // A's own late fail, with the secret A was given, is dead twice over:
    // the claim is B's now AND the stored hash is B's. So the refund that
    // already went to A cannot go to A a second time.
    expect(await failCall(userA, liveQuestion, first.secret)).toBe(false);
    expect(await finish(userA, liveQuestion, first.secret)).toBe(false);
    expect(await usedToday(userA)).toBe(0);
    expect(await usedToday(userB)).toBe(1);

    // And B, who paid for the call in flight, still finishes it.
    expect(await finish(userB, liveQuestion, second.secret)).toBe(true);
    expect(await usedToday(userB)).toBe(1);
  });

  it('reads the row it is about to refund under a row lock', async () => {
    // The race the 0032 code lost: the stale row was read with no lock, so
    // the first claimant's `fail`, committing between that read and the
    // upsert, was refunded AND then refunded again by the takeover.
    //
    // PGlite is one connection, so the two cannot really interleave here.
    // What is checkable is the lock itself, which is what removes the
    // window: the authoritative read has to be `for update`.
    const r = await db.admin.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'claim_ai_explanation'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].src.toLowerCase()).toContain('for update');
  });

  it('refuses the takeover when the new caller is at the cap, and refunds nobody', async () => {
    await claim(userA, liveQuestion);
    await ageClaim(liveQuestion);
    await db.admin.query(
      `insert into public.ai_usage (user_id, ist_date, new_count)
       values ($1, public.ist_today(), 30)`,
      [userB],
    );

    const refused = await claim(userB, liveQuestion);
    expect(refused.code).toBe('limit');
    expect(refused.secret).toBeNull();
    expect((await stored(liveQuestion))?.claimed_by).toBe(userA);
    expect(await usedToday(userA)).toBe(1);
  });
});

describe('explanation audio: the same secret rule', () => {
  it('hands a secret only to the call that claimed', async () => {
    await seedReady(liveQuestion);

    const first = await claimAudio(userA, liveQuestion);
    expect(first.code).toBe('claimed');
    expect(first.secret).not.toBeNull();

    const again = await claimAudio(userA, liveQuestion);
    expect(again.code).toBe('making');
    expect(again.secret).toBeNull();

    const row = await stored(liveQuestion);
    expect(row?.audio_claim_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.audio_claim_secret_hash).not.toBe(first.secret);
  });

  it('refuses a finish and a fail without the secret', async () => {
    await seedReady(liveQuestion);
    const { secret } = await claimAudio(userA, liveQuestion);

    expect(await finishAudioWithNoSecretArgument(userA, liveQuestion)).toBe(false);
    expect(await finishAudio(userA, liveQuestion, null)).toBe(false);
    expect(await finishAudio(userA, liveQuestion, WRONG_SECRET)).toBe(false);
    expect(await failAudioWithNoSecretArgument(userA, liveQuestion)).toBe(false);
    expect(await failAudio(userA, liveQuestion, WRONG_SECRET)).toBe(false);
    expect((await stored(liveQuestion))?.audio_status).toBe('making');

    expect(await finishAudio(userA, liveQuestion, secret)).toBe(true);
    const row = await stored(liveQuestion);
    expect(row?.audio_status).toBe('ready');
    expect(row?.audio_path).toBe(audioPath(liveQuestion));
  });

  it('releases a claimed slot with the right secret, once', async () => {
    await seedReady(liveQuestion);
    const { secret } = await claimAudio(userA, liveQuestion);

    expect(await failAudio(userA, liveQuestion, secret)).toBe(true);
    expect((await stored(liveQuestion))?.audio_status).toBe('failed');
    expect((await stored(liveQuestion))?.audio_claim_secret_hash).toBeNull();
    expect(await failAudio(userA, liveQuestion, secret)).toBe(false);
  });

  it('still refuses another student holding the right secret', async () => {
    await seedReady(liveQuestion);
    const { secret } = await claimAudio(userA, liveQuestion);

    expect(await finishAudio(userB, liveQuestion, secret)).toBe(false);
    expect(await failAudio(userB, liveQuestion, secret)).toBe(false);
    expect((await stored(liveQuestion))?.audio_status).toBe('making');
  });

  it('kills the old secret on an audio takeover', async () => {
    await seedReady(liveQuestion);
    const first = await claimAudio(userA, liveQuestion);
    await ageAudioClaim(liveQuestion);

    const second = await claimAudio(userB, liveQuestion);
    expect(second.code).toBe('claimed');
    expect(second.secret).not.toBe(first.secret);

    expect(await finishAudio(userA, liveQuestion, first.secret)).toBe(false);
    expect(await failAudio(userA, liveQuestion, first.secret)).toBe(false);
    expect(await finishAudio(userB, liveQuestion, second.secret)).toBe(true);
  });

  it('still refuses a path outside the explanation folder', async () => {
    await seedReady(liveQuestion);
    const { secret } = await claimAudio(userA, liveQuestion);

    expect(await finishAudio(userA, liveQuestion, secret, 'explanations/one/en.mp3')).toBe(
      false,
    );
    expect(
      await finishAudio(userA, liveQuestion, secret, `explanations/${liveQuestion}/../x/en.mp3`),
    ).toBe(false);
    expect(await finishAudio(userA, liveQuestion, secret)).toBe(true);
  });
});

describe('a teacher edit does not inherit the secret', () => {
  it('pins the text hash and clears the audio hash when the body changes', async () => {
    const { secret } = await claim(userA, liveQuestion);
    expect(await finish(userA, liveQuestion, secret)).toBe(true);

    const before = await stored(liveQuestion);
    expect(before?.claim_secret_hash).toMatch(/^[0-9a-f]{64}$/);

    await db.admin.query(
      `update public.ai_explanations
       set audio_status = 'ready', audio_path = $2,
           audio_claimed_by = $3, audio_claimed_at = now(),
           audio_claim_secret_hash = repeat('a', 64)
       where question_id = $1 and lang = 'en'`,
      [liveQuestion, audioPath(liveQuestion), userA],
    );

    // The teacher corrects the text. Their own hash may not go on the row.
    await db.asUser(teacher, (sql) =>
      sql.query(
        `update public.ai_explanations
         set body = $1::jsonb, edited_by_teacher = true,
             claim_secret_hash = repeat('b', 64),
             audio_claim_secret_hash = repeat('b', 64)
         where question_id = $2 and lang = 'en'`,
        [
          JSON.stringify({
            exam: 'UGC NET',
            topic: 'Parliament',
            question: 'Which house is the Council of States?',
            sections: [{ heading: 'Fixed', body: 'By the teacher.' }],
            remember: 'Rajya Sabha.',
          }),
          liveQuestion,
        ],
      ),
    );

    const after = await stored(liveQuestion);
    expect(after?.claim_secret_hash).toBe(before?.claim_secret_hash);
    // New text, so the old narration is wrong and its claim is wiped whole.
    expect(after?.audio_status).toBe('none');
    expect(after?.audio_claim_secret_hash).toBeNull();
  });
});
