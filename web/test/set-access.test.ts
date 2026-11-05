/**
 * Set access: who may read a mock question (issue 16-set-access-mock-list).
 *
 * design.md RLS: "a student can read a mock question only if `set_access` has
 * a valid row for its set (purchase, batch, admin) OR the test is a free
 * sample." This file is that sentence turned into Postgres.
 *
 * The four facts the definition of done names:
 *
 *  1. the FREE SAMPLE is readable with no `set_access` row at all,
 *  2. a LOCKED test gives a student 0 questions, not a short list,
 *  3. an ADMIN GRANT opens it,
 *  4. an EXPIRED grant closes it again.
 *
 * Plus the two a paywall lives or dies by:
 *
 *  5. a student cannot grant THEMSELVES access (that would be the whole
 *     product for free, one INSERT at a time),
 *  6. a student never reads another student's `set_access` row.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. Owns the set under test. */
let teacher: string;
/** A plain student. Buys nothing until a test says so. */
let student: string;
/** A second student, so "my access" can be told apart from "somebody's access". */
let other: string;
/** The only user who may write a `set_access` row in this slice. */
let adminUser: string;

/** UGC NET, from the 0004 seed. */
const NET = 'a4000001-0000-4000-8000-000000000001';

const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

let setId: string;
/** Test 1, the free sample. */
let freeTest: string;
/** Test 2, paid. */
let paidTest: string;

async function insertSet(status = 'live'): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, 'Full length set 1', 399, $3)
     returning id`,
    [teacher, NET, status],
  );
  return res.rows[0].id;
}

async function insertTest(values: {
  position: number;
  isFreeSample?: boolean;
}): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, is_free_sample)
     values ($1, $2, $3, $4)
     returning id`,
    [setId, 'Test ' + values.position, values.position, values.isFreeSample ?? false],
  );
  return res.rows[0].id;
}

/** One LIVE, CHECKED question on a test: what a student is meant to read. */
async function insertQuestion(testId: string, number = 1): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx, checked, status)
     values ($1, null, $2, $3, 'Which house is the Council of States?', $4::jsonb, 1, true, 'live')
     returning id`,
    [teacher, testId, number, OPTIONS],
  );
  return res.rows[0].id;
}

/** Grant a set by hand, the way the admin screen does: through RLS. */
function grantAs(
  actor: string,
  values: { userId: string; setId: string; source?: string; validUntil?: string },
): Promise<void> {
  return db.asUser(actor, async (sql) => {
    await sql.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, $3, $4::timestamptz)
       on conflict (user_id, set_id, source)
       do update set valid_until = excluded.valid_until`,
      [
        values.userId,
        values.setId,
        values.source ?? 'admin',
        values.validUntil ?? new Date(Date.now() + 86_400_000).toISOString(),
      ],
    );
  });
}

/** How many questions of one test this user can actually read. */
function questionCount(userId: string, testId: string): Promise<number> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<{ n: number }>(
      'select count(*)::int as n from public.questions where test_id = $1',
      [testId],
    );
    return res.rows[0].n;
  });
}

beforeAll(async () => {
  db = await createTestDb();

  teacher = await db.createUser();
  student = await db.createUser();
  other = await db.createUser();
  adminUser = await db.createUser();

  // `profiles_block_role_change` refuses a role change by anybody but an
  // admin, so the first admin is seeded as a fresh row, not an update.
  await db.admin.query('delete from public.profiles where id = $1', [adminUser]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [
    adminUser,
  ]);

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
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');

  setId = await insertSet();
  freeTest = await insertTest({ position: 1, isFreeSample: true });
  paidTest = await insertTest({ position: 2 });
  await insertQuestion(freeTest);
  await insertQuestion(paidTest);
});

describe('0016_set_access.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0016_set_access.sql');
  });

  it('has row level security on set_access', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      'select relrowsecurity from pg_class where oid = $1::regclass',
      ['public.set_access'],
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('keys a row by user, set AND source, so two sources can overlap', async () => {
    await grantAs(adminUser, { userId: student, setId });
    await db.admin.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'batch', now() + interval '1 day')`,
      [student, setId],
    );

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.set_access where user_id = $1 and set_id = $2',
      [student, setId],
    );
    expect(res.rows[0].n).toBe(2);
  });

  it('refuses a source it does not know', async () => {
    await expect(
      db.admin.query(
        `insert into public.set_access (user_id, set_id, source, valid_until)
         values ($1, $2, 'gift', now() + interval '1 day')`,
        [student, setId],
      ),
    ).rejects.toThrow();
  });
});

describe('reading a mock question', () => {
  it('opens the free sample test to a student with no access at all', async () => {
    expect(await questionCount(student, freeTest)).toBe(1);
  });

  it('gives 0 questions for a locked test', async () => {
    expect(await questionCount(student, paidTest)).toBe(0);
  });

  it('opens the locked test after an admin grant', async () => {
    await grantAs(adminUser, { userId: student, setId });
    expect(await questionCount(student, paidTest)).toBe(1);
  });

  it('closes it again when the grant has expired', async () => {
    await grantAs(adminUser, { userId: student, setId });
    expect(await questionCount(student, paidTest)).toBe(1);

    await db.admin.query(
      `update public.set_access set valid_until = now() - interval '1 minute'
       where user_id = $1 and set_id = $2`,
      [student, setId],
    );
    expect(await questionCount(student, paidTest)).toBe(0);
  });

  it('does not let one student ride another student grant', async () => {
    await grantAs(adminUser, { userId: other, setId });
    expect(await questionCount(other, paidTest)).toBe(1);
    expect(await questionCount(student, paidTest)).toBe(0);
  });

  it('leaves the teacher their own questions, locked set or not', async () => {
    // The teacher never buys their own set, and a draft is theirs to read.
    await db.admin.query("update public.questions set status = 'draft', checked = false");
    expect(await questionCount(teacher, paidTest)).toBe(1);
  });

  it('still hides a draft question from a student who HAS paid', async () => {
    await grantAs(adminUser, { userId: student, setId });
    await db.admin.query(
      "update public.questions set status = 'draft', checked = false where test_id = $1",
      [paidTest],
    );
    expect(await questionCount(student, paidTest)).toBe(0);
  });

  it('leaves past-paper questions alone: no test, no set to unlock', async () => {
    const paper = await db.admin.query<{ id: string }>(
      `insert into public.papers
         (teacher_id, exam_id, year, label, pdf_questions_path, status)
       values ($1, $2, 2025, 'NET 2025', 'papers/net-2025.pdf', 'live')
       returning id`,
      [teacher, NET],
    );
    await db.admin.query(
      `insert into public.questions
         (teacher_id, paper_id, test_id, number, stem, options, correct_idx, checked, status)
       values ($1, $2, null, 1, 'Who is the Speaker?', $3::jsonb, 0, true, 'live')`,
      [teacher, paper.rows[0].id, OPTIONS],
    );

    const n = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ n: number }>(
        'select count(*)::int as n from public.questions where paper_id = $1',
        [paper.rows[0].id],
      );
      return res.rows[0].n;
    });
    expect(n).toBe(1);
  });
});

describe('has_test_access()', () => {
  async function ask(userId: string, testId: string | null): Promise<boolean> {
    return db.asUser(userId, async (sql) => {
      const res = await sql.query<{ ok: boolean }>(
        'select public.has_test_access($1::uuid) as ok',
        [testId],
      );
      return res.rows[0].ok;
    });
  }

  it('is false for a test that does not exist', async () => {
    expect(await ask(student, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('is false for a null test id', async () => {
    expect(await ask(student, null)).toBe(false);
  });

  it('is true for the free sample and false for the paid test', async () => {
    expect(await ask(student, freeTest)).toBe(true);
    expect(await ask(student, paidTest)).toBe(false);
  });

  it('is true for a valid batch grant as well as a purchase', async () => {
    for (const source of ['purchase', 'batch'] as const) {
      await db.admin.query('delete from public.set_access');
      await db.admin.query(
        `insert into public.set_access (user_id, set_id, source, valid_until)
         values ($1, $2, $3, now() + interval '1 day')`,
        [student, setId, source],
      );
      expect(await ask(student, paidTest)).toBe(true);
    }
  });
});

describe('set_access policies', () => {
  it('lets a student read their own row and nobody else', async () => {
    await grantAs(adminUser, { userId: student, setId });
    await grantAs(adminUser, { userId: other, setId });

    const rows = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ user_id: string }>(
        'select user_id from public.set_access',
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(student);
  });

  it('refuses a student who tries to grant the set to themselves', async () => {
    await expect(grantAs(student, { userId: student, setId })).rejects.toThrow();
    expect(await questionCount(student, paidTest)).toBe(0);
  });

  it('refuses a teacher handing their own set out', async () => {
    // Batch access is issue 19 and goes through a batch, not a hand-written row.
    await expect(grantAs(teacher, { userId: student, setId })).rejects.toThrow();
  });

  it('lets an admin end a grant by deleting the row', async () => {
    await grantAs(adminUser, { userId: student, setId });
    await db.asUser(adminUser, async (sql) => {
      await sql.query('delete from public.set_access where user_id = $1', [student]);
    });

    const res = await db.admin.query<{ n: number }>(
      'select count(*)::int as n from public.set_access',
    );
    expect(res.rows[0].n).toBe(0);
    expect(await questionCount(student, paidTest)).toBe(0);
  });
});
