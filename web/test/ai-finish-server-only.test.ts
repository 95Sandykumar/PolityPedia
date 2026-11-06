/**
 * ONLY THE SERVER FINISHES OR FAILS A CLAIM (issue 41-ai-finish-server-only).
 *
 * Issue 37 gave a claim a one-time SECRET and made `finish_*` / `fail_*` need
 * it. That closed the replay, and left one door open: the four functions were
 * still `grant execute ... to authenticated`, so a student on the AI plan
 * could do the whole dance from the browser over REST:
 *
 *   1. post `rpc/claim_ai_explanation`. The database hands back THEIR OWN
 *      secret, because they are the call that created the claim.
 *   2. post `rpc/finish_ai_explanation` with that secret, plus any text and
 *      any sources they liked.
 *   3. the row is `ready`. Every student who opens that question from then on
 *      reads what the attacker wrote. It cost 1 of their 30.
 *
 * `fail_ai_explanation` was the same shape against the 30-a-day cap, and both
 * audio functions were the same shape against the paid voice.
 *
 * THE FIX has two halves, and this file tests both:
 *
 *  a. EXECUTE is revoked from `public`, `anon` and `authenticated`, and
 *     granted to `service_role` alone. A browser cannot call these at all any
 *     more: it gets a permission error, not a `false`.
 *  b. because a service-role call has NO `auth.uid()`, the functions find
 *     their row by `(question_id, lang)` and the SECRET, and the refund goes
 *     to the `claimed_by` stored on the row. The secret is now the whole
 *     proof of identity, which is why it is required and single use.
 *
 * `claim_ai_explanation` and `claim_explanation_audio` STAY on
 * `authenticated`: the plan gate, the 30-a-day count and the exam lock all
 * read `auth.uid()`, and they must keep reading the student's own.
 *
 * Seed with `db.admin` (bypasses RLS), act through `db.asUser` (a browser) or
 * `db.asService` (our own server holding the server-only key).
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

/** What a second, losing `finish` would write if it were ever allowed to. */
const OTHER_BODY = JSON.stringify({
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'Buy my course instead.' }],
  remember: 'Not the real explanation.',
});

const GOOD_SOURCE = { title: 'India Code', url: 'https://www.indiacode.nic.in/' };

/** A secret that was never issued. Shaped right, so only the hash refuses it. */
const WRONG_SECRET = '11111111-2222-4333-8444-555555555555';

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

// --------------------------------------------------------------------------
// The two claims. Still the STUDENT'S OWN call, over REST, with their token.
// --------------------------------------------------------------------------

function claim(userId: string, questionId: string, lang = 'en'): Promise<ClaimOutcome> {
  return db.asUser(userId, async (sql) => {
    const r = await sql.query<{ out: unknown }>(
      'select public.claim_ai_explanation($1, $2) as out',
      [questionId, lang],
    );
    return readOutcome(r.rows[0].out);
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

// --------------------------------------------------------------------------
// The four server-only calls, as OUR SERVER makes them: role `service_role`,
// no `auth.uid()` at all.
// --------------------------------------------------------------------------

const FINISH_SQL = `select public.finish_ai_explanation(
  $1, $2, $3::jsonb, $4::jsonb, 'claude-haiku-5-5', 900, 450, 2, $5::uuid
) as saved`;

const FAIL_SQL = 'select public.fail_ai_explanation($1, $2, $3::uuid) as gave_back';

const FINISH_AUDIO_SQL =
  'select public.finish_explanation_audio($1, $2, $3, $4::uuid) as saved';

const FAIL_AUDIO_SQL = 'select public.fail_explanation_audio($1, $2, $3::uuid) as released';

function serviceFinish(
  questionId: string,
  secret: string | null,
  body = BODY,
  lang = 'en',
): Promise<boolean> {
  return db.asService(async (sql) => {
    const r = await sql.query<{ saved: boolean }>(FINISH_SQL, [
      questionId,
      lang,
      body,
      JSON.stringify([GOOD_SOURCE]),
      secret,
    ]);
    return r.rows[0].saved;
  });
}

function serviceFail(
  questionId: string,
  secret: string | null,
  lang = 'en',
): Promise<boolean> {
  return db.asService(async (sql) => {
    const r = await sql.query<{ gave_back: boolean }>(FAIL_SQL, [questionId, lang, secret]);
    return r.rows[0].gave_back;
  });
}

function serviceFinishAudio(
  questionId: string,
  secret: string | null,
  path?: string,
  lang = 'en',
): Promise<boolean> {
  return db.asService(async (sql) => {
    const r = await sql.query<{ saved: boolean }>(FINISH_AUDIO_SQL, [
      questionId,
      lang,
      path ?? audioPath(questionId, lang),
      secret,
    ]);
    return r.rows[0].saved;
  });
}

function serviceFailAudio(
  questionId: string,
  secret: string | null,
  lang = 'en',
): Promise<boolean> {
  return db.asService(async (sql) => {
    const r = await sql.query<{ released: boolean }>(FAIL_AUDIO_SQL, [
      questionId,
      lang,
      secret,
    ]);
    return r.rows[0].released;
  });
}

// --------------------------------------------------------------------------
// Reading what is really stored
// --------------------------------------------------------------------------

interface StoredRow {
  status: string;
  body: { sections?: { body?: string }[] } | null;
  claimed_by: string | null;
  claim_secret_hash: string | null;
  audio_status: string;
  audio_path: string | null;
  audio_claimed_by: string | null;
  audio_claim_secret_hash: string | null;
}

async function stored(questionId: string, lang = 'en'): Promise<StoredRow | null> {
  const r = await db.admin.query<StoredRow>(
    `select status, body, claimed_by, claim_secret_hash,
            audio_status, audio_path, audio_claimed_by, audio_claim_secret_hash
     from public.ai_explanations where question_id = $1 and lang = $2`,
    [questionId, lang],
  );
  return r.rows[0] ?? null;
}

/** The first section's text, which is what a second `finish` would replace. */
function firstSection(row: StoredRow | null): string {
  return row?.body?.sections?.[0]?.body ?? '';
}

async function usedToday(userId: string): Promise<number> {
  const r = await db.admin.query<{ new_count: number }>(
    'select new_count from public.ai_usage where user_id = $1 and ist_date = public.ist_today()',
    [userId],
  );
  return r.rows[0]?.new_count ?? 0;
}

/** Whether one role may EXECUTE one function, by its exact argument list. */
async function canExecute(signature: string, role: string): Promise<boolean> {
  const r = await db.admin.query<{ ok: boolean }>(
    'select has_function_privilege($1, $2, $3) as ok',
    [role, signature, 'execute'],
  );
  return r.rows[0].ok;
}

/**
 * Every grantee of EXECUTE, read straight off the function's ACL.
 *
 * `has_function_privilege` cannot be asked about PUBLIC (it is a pseudo-role,
 * not a row in `pg_roles`), and PUBLIC is the grant that would quietly let
 * every future role in. Grantee OID 0 IS public, and `0::regrole` prints as
 * `-`, so that is what gets translated back.
 */
async function executeGrantees(signature: string): Promise<string[]> {
  const r = await db.admin.query<{ grantee: string }>(
    `select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
     from pg_proc p
     cross join aclexplode(p.proacl) a
     where p.oid = $1::regprocedure
       and a.privilege_type = 'EXECUTE'
     order by 1`,
    [signature],
  );
  return r.rows.map((row) => row.grantee);
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
});

// --------------------------------------------------------------------------
// a. The grant
// --------------------------------------------------------------------------

/** The four, by the exact signature a REST call resolves to. */
const SERVER_ONLY = [
  'public.finish_ai_explanation(uuid, text, jsonb, jsonb, text, integer, integer, integer, uuid)',
  'public.fail_ai_explanation(uuid, text, uuid)',
  'public.finish_explanation_audio(uuid, text, text, uuid)',
  'public.fail_explanation_audio(uuid, text, uuid)',
] as const;

describe('the four finish/fail functions are server-only', () => {
  it.each(SERVER_ONLY)('%s is granted to service_role and nobody else', async (signature) => {
    expect(await canExecute(signature, 'service_role')).toBe(true);
    expect(await canExecute(signature, 'authenticated')).toBe(false);
    expect(await canExecute(signature, 'anon')).toBe(false);
    // PUBLIC would let in every role that does not exist yet.
    expect(await executeGrantees(signature)).not.toContain('PUBLIC');
    expect(await executeGrantees(signature)).toContain('service_role');
  });

  it('leaves both CLAIM functions callable by a signed-in student', async () => {
    // The daily limit, the plan gate and the exam lock all read `auth.uid()`,
    // so these two have to stay where they are.
    expect(await canExecute('public.claim_ai_explanation(uuid, text)', 'authenticated')).toBe(
      true,
    );
    expect(
      await canExecute('public.claim_explanation_audio(uuid, text)', 'authenticated'),
    ).toBe(true);
  });

  it('refuses the browser outright, even holding its own valid secret', async () => {
    const claimed = await claim(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');
    expect(claimed.secret).not.toBeNull();

    // THE ATTACK FROM THE ISSUE. The secret is genuine: the student's own
    // claim produced it. It no longer matters, because the function is not
    // reachable with their key.
    await expect(
      db.asUser(userA, (sql) =>
        sql.query(FINISH_SQL, [
          liveQuestion,
          'en',
          OTHER_BODY,
          '[]',
          claimed.secret,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(userA, (sql) =>
        sql.query(FAIL_SQL, [liveQuestion, 'en', claimed.secret]),
      ),
    ).rejects.toThrow(/permission denied/i);

    // Nothing moved: still our call, still charged, still no text.
    const row = await stored(liveQuestion);
    expect(row?.status).toBe('generating');
    expect(row?.body).toBeNull();
    expect(await usedToday(userA)).toBe(1);
  });

  it('refuses the browser on both audio functions too', async () => {
    await seedReady(liveQuestion);
    const claimed = await claimAudio(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    await expect(
      db.asUser(userA, (sql) =>
        sql.query(FINISH_AUDIO_SQL, [
          liveQuestion,
          'en',
          audioPath(liveQuestion),
          claimed.secret,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(userA, (sql) =>
        sql.query(FAIL_AUDIO_SQL, [liveQuestion, 'en', claimed.secret]),
      ),
    ).rejects.toThrow(/permission denied/i);

    const row = await stored(liveQuestion);
    expect(row?.audio_status).toBe('making');
    expect(row?.audio_path).toBeNull();
  });
});

// --------------------------------------------------------------------------
// b. The server's own call, with no auth.uid() to lean on
// --------------------------------------------------------------------------

describe('finish_ai_explanation as the service role', () => {
  it('saves once, and a second call saves nothing', async () => {
    const claimed = await claim(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    expect(await serviceFinish(liveQuestion, claimed.secret)).toBe(true);
    const saved = await stored(liveQuestion);
    expect(saved?.status).toBe('ready');
    expect(firstSection(saved)).toBe('The Rajya Sabha.');
    // Single use: the hash is gone, so the secret cannot be replayed.
    expect(saved?.claim_secret_hash).toBeNull();
    // The claim still names the student who paid for it.
    expect(saved?.claimed_by).toBe(userA);

    expect(await serviceFinish(liveQuestion, claimed.secret, OTHER_BODY)).toBe(false);
    expect(firstSection(await stored(liveQuestion))).toBe('The Rajya Sabha.');
  });

  it('refuses a wrong or missing secret, and changes nothing', async () => {
    const claimed = await claim(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    expect(await serviceFinish(liveQuestion, WRONG_SECRET, OTHER_BODY)).toBe(false);
    expect(await serviceFinish(liveQuestion, null, OTHER_BODY)).toBe(false);

    const row = await stored(liveQuestion);
    expect(row?.status).toBe('generating');
    expect(row?.body).toBeNull();
    expect(row?.claim_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    // Still charged: nothing failed, so nothing is given back.
    expect(await usedToday(userA)).toBe(1);
  });
});

describe('fail_ai_explanation as the service role', () => {
  it('refunds the student named on the row, exactly once', async () => {
    const claimed = await claim(userA, liveQuestion);
    expect(await usedToday(userA)).toBe(1);

    // The refund has to find userA from `claimed_by`: a service-role call has
    // no `auth.uid()` to read.
    expect(await serviceFail(liveQuestion, claimed.secret)).toBe(true);
    expect(await usedToday(userA)).toBe(0);

    const row = await stored(liveQuestion);
    expect(row?.status).toBe('failed');
    expect(row?.claim_secret_hash).toBeNull();

    // The free call this whole chain exists to refuse.
    expect(await serviceFail(liveQuestion, claimed.secret)).toBe(false);
    expect(await usedToday(userA)).toBe(0);
  });

  it('refuses a wrong or missing secret, and refunds nothing', async () => {
    const claimed = await claim(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    expect(await serviceFail(liveQuestion, WRONG_SECRET)).toBe(false);
    expect(await serviceFail(liveQuestion, null)).toBe(false);

    expect((await stored(liveQuestion))?.status).toBe('generating');
    expect(await usedToday(userA)).toBe(1);
  });

  it('refunds on the India day the claim was CHARGED, not today', async () => {
    const claimed = await claim(userA, liveQuestion);

    // Move both the claim and its charge back one India day.
    await db.admin.query(
      `update public.ai_explanations
       set claimed_at = now() - interval '1 day'
       where question_id = $1 and lang = 'en'`,
      [liveQuestion],
    );
    await db.admin.query('delete from public.ai_usage where user_id = $1', [userA]);
    await db.admin.query(
      `insert into public.ai_usage (user_id, ist_date, new_count)
       values ($1, public.ist_today() - 1, 1)`,
      [userA],
    );

    expect(await serviceFail(liveQuestion, claimed.secret)).toBe(true);

    const yesterday = await db.admin.query<{ new_count: number }>(
      `select new_count from public.ai_usage
       where user_id = $1 and ist_date = public.ist_today() - 1`,
      [userA],
    );
    expect(yesterday.rows[0].new_count).toBe(0);
  });
});

describe('a stale takeover, settled by the server', () => {
  it('refunds the first claimant exactly once and kills their secret', async () => {
    const first = await claim(userA, liveQuestion);
    expect(first.code).toBe('claimed');
    expect(await usedToday(userA)).toBe(1);

    await ageClaim(liveQuestion);

    const second = await claim(userB, liveQuestion);
    expect(second.code).toBe('claimed');
    expect(second.secret).not.toBe(first.secret);
    // The takeover is what refunds A, and it may only do it once.
    expect(await usedToday(userA)).toBe(0);
    expect(await usedToday(userB)).toBe(1);

    // A's late reply arrives at our server. Its secret is dead, so it can
    // neither write B's text nor take B's call back.
    expect(await serviceFinish(liveQuestion, first.secret, OTHER_BODY)).toBe(false);
    expect(await serviceFail(liveQuestion, first.secret)).toBe(false);
    expect(await usedToday(userA)).toBe(0);
    expect(await usedToday(userB)).toBe(1);

    const row = await stored(liveQuestion);
    expect(row?.status).toBe('generating');
    expect(row?.claimed_by).toBe(userB);

    // B's own secret still works, and the refund goes to B, not to A.
    expect(await serviceFail(liveQuestion, second.secret)).toBe(true);
    expect(await usedToday(userB)).toBe(0);
    expect(await usedToday(userA)).toBe(0);
  });
});

describe('the audio half, as the service role', () => {
  beforeEach(async () => {
    await seedReady(liveQuestion);
  });

  it('saves the path once, and a second call saves nothing', async () => {
    const claimed = await claimAudio(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    expect(await serviceFinishAudio(liveQuestion, claimed.secret)).toBe(true);
    const row = await stored(liveQuestion);
    expect(row?.audio_status).toBe('ready');
    expect(row?.audio_path).toBe(audioPath(liveQuestion));
    expect(row?.audio_claim_secret_hash).toBeNull();
    expect(row?.audio_claimed_by).toBe(userA);

    expect(await serviceFinishAudio(liveQuestion, claimed.secret)).toBe(false);
  });

  it('refuses a wrong or missing secret, and stores no path', async () => {
    const claimed = await claimAudio(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    expect(await serviceFinishAudio(liveQuestion, WRONG_SECRET)).toBe(false);
    expect(await serviceFinishAudio(liveQuestion, null)).toBe(false);

    const row = await stored(liveQuestion);
    expect(row?.audio_status).toBe('making');
    expect(row?.audio_path).toBeNull();
  });

  it('keeps the path rule, so a service-role call cannot write anywhere', async () => {
    const claimed = await claimAudio(userA, liveQuestion);
    expect(
      await serviceFinishAudio(liveQuestion, claimed.secret, 'papers/secret.pdf'),
    ).toBe(false);
    expect(
      await serviceFinishAudio(
        liveQuestion,
        claimed.secret,
        `explanations/${liveQuestion}/../other.mp3`,
      ),
    ).toBe(false);
    expect((await stored(liveQuestion))?.audio_path).toBeNull();
  });

  it('releases a claimed slot once, and a second call releases nothing', async () => {
    const claimed = await claimAudio(userA, liveQuestion);
    expect(claimed.code).toBe('claimed');

    expect(await serviceFailAudio(liveQuestion, claimed.secret)).toBe(true);
    const row = await stored(liveQuestion);
    expect(row?.audio_status).toBe('failed');
    expect(row?.audio_claim_secret_hash).toBeNull();

    expect(await serviceFailAudio(liveQuestion, claimed.secret)).toBe(false);
    expect(await serviceFailAudio(liveQuestion, WRONG_SECRET)).toBe(false);
    expect(await serviceFailAudio(liveQuestion, null)).toBe(false);
  });

  it('kills the first caller secret when a stale voice claim is taken over', async () => {
    const first = await claimAudio(userA, liveQuestion);
    expect(first.code).toBe('claimed');

    await db.admin.query(
      `update public.ai_explanations
       set audio_claimed_at = now() - interval '3 minutes'
       where question_id = $1 and lang = 'en'`,
      [liveQuestion],
    );

    const second = await claimAudio(userB, liveQuestion);
    expect(second.code).toBe('claimed');
    expect(second.secret).not.toBe(first.secret);

    expect(await serviceFinishAudio(liveQuestion, first.secret)).toBe(false);
    expect(await serviceFailAudio(liveQuestion, first.secret)).toBe(false);
    expect((await stored(liveQuestion))?.audio_status).toBe('making');

    expect(await serviceFinishAudio(liveQuestion, second.secret)).toBe(true);
    expect((await stored(liveQuestion))?.audio_status).toBe('ready');
  });
});
