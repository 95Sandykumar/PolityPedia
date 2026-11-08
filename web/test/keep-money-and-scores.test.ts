/**
 * Deleting a mock set, test, paper or batch never erases money or scores
 * (issue 45-keep-money-and-scores, migration 0041).
 *
 * The bug: `purchases.set_id` was ON DELETE CASCADE, so a teacher deleting a
 * set erased the payments, the buyers' access and (through mock_tests ->
 * attempts) every student's score. These tests prove, in Postgres with RLS on:
 *
 *   (a) a set with a purchase is ARCHIVED, and the purchase, the access row
 *       and the buyer's results all survive;
 *   (b) an empty draft set is really deleted;
 *   (c) the foreign keys refuse a hard delete underneath the functions;
 *   (d) a stranger can neither remove nor restore someone else's object;
 *   (e) a restore after 31 days is refused;
 *   (f) an archived test refuses a new attempt.
 *
 * Plus the same rules for tests, papers and batches, and the batch rule that
 * archiving withdraws batch-sourced set_access but keeps the reports.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (every policy
 * is evaluated for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

let teacherA: string;
let teacherB: string;
let buyer: string;
let stranger: string;

const NET = 'a4000001-0000-4000-8000-000000000001';
const OPTIONS = JSON.stringify(['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither']);

async function insertSet(
  teacher: string,
  title: string,
  status: 'draft' | 'live' = 'live',
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, price_inr, status)
     values ($1, $2, $3, 299, $4) returning id`,
    [teacher, NET, title, status],
  );
  return res.rows[0].id;
}

async function insertTest(setId: string, position = 1, free = false): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.mock_tests (set_id, title, position, is_free_sample)
     values ($1, $2, $3, $4) returning id`,
    [setId, 'Test ' + position, position, free],
  );
  return res.rows[0].id;
}

async function insertQuestion(teacher: string, testId: string): Promise<void> {
  await db.admin.query(
    `insert into public.questions
       (teacher_id, paper_id, test_id, number, stem, options, correct_idx, checked, status)
     values ($1, null, $2, 1, 'Which house is the Council of States?', $3::jsonb, 1, true, 'live')`,
    [teacher, testId, OPTIONS],
  );
}

async function insertPurchase(user: string, setId: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.purchases (user_id, set_id, razorpay_order_id, amount_inr, status)
     values ($1, $2, $3, 299, 'paid') returning id`,
    [user, setId, 'order_' + Math.random().toString(36).slice(2)],
  );
  return res.rows[0].id;
}

async function grantAccess(user: string, setId: string, source = 'purchase'): Promise<void> {
  await db.admin.query(
    `insert into public.set_access (user_id, set_id, source, valid_until)
     values ($1, $2, $3, 'infinity')`,
    [user, setId, source],
  );
}

/** A submitted, scored sitting: the student's score. */
async function insertScoredAttempt(user: string, testId: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.attempts (user_id, test_id, mode, submitted_at, score)
     values ($1, $2, 'practice', now(), 7) returning id`,
    [user, testId],
  );
  return res.rows[0].id;
}

async function insertPaper(teacher: string, label: string): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.papers (teacher_id, exam_id, year, label, pdf_questions_path, status)
     values ($1, $2, 2024, $3, 'papers/q.pdf', 'live') returning id`,
    [teacher, NET, label],
  );
  return res.rows[0].id;
}

function call(user: string, fn: string, id: string): Promise<string> {
  return db.asUser(user, async (sql) => {
    const res = await sql.query<{ r: string }>(`select public.${fn}($1) as r`, [id]);
    return res.rows[0].r;
  });
}

async function count(table: string, where: string, args: unknown[]): Promise<number> {
  const res = await db.admin.query<{ n: number }>(
    `select count(*)::int as n from public.${table} where ${where}`,
    args,
  );
  return res.rows[0].n;
}

async function archivedAt(table: string, id: string): Promise<Date | null> {
  const res = await db.admin.query<{ archived_at: string | null }>(
    `select archived_at from public.${table} where id = $1`,
    [id],
  );
  const raw = res.rows[0]?.archived_at;
  return raw ? new Date(raw) : null;
}

/** Pretend it was archived `days` ago. Admin handle: the guard lets it through. */
async function ageArchive(table: string, id: string, days: number): Promise<void> {
  await db.admin.query(
    `update public.${table} set archived_at = now() - ($2 || ' days')::interval where id = $1`,
    [id, String(days)],
  );
}

function visibleSets(user: string): Promise<string[]> {
  return db.asUser(user, async (sql) => {
    const res = await sql.query<{ id: string }>('select id from public.mock_sets');
    return res.rows.map((r) => r.id);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  teacherA = await db.createUser();
  teacherB = await db.createUser();
  buyer = await db.createUser();
  stranger = await db.createUser();

  for (const teacher of [teacherA, teacherB]) {
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', 'Polity Guru', 'approved')`,
      [teacher],
    );
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.admin.query('delete from public.attempts');
  await db.admin.query('delete from public.teacher_ledger');
  await db.admin.query('delete from public.purchases');
  await db.admin.query('delete from public.set_access');
  await db.admin.query('delete from public.batches');
  await db.admin.query('delete from public.questions');
  await db.admin.query('delete from public.mock_tests');
  await db.admin.query('delete from public.mock_sets');
  await db.admin.query('delete from public.papers');
});

describe('0041_keep_money_and_scores.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0041_keep_money_and_scores.sql');
  });

  it('turned the five cascades into restrict', async () => {
    const res = await db.admin.query<{ child: string; parent: string; confdeltype: string }>(
      `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
              c.confdeltype
       from pg_constraint c
       where c.contype = 'f'
         and (c.conrelid::regclass::text, c.confrelid::regclass::text) in (
           ('purchases', 'mock_sets'), ('teacher_ledger', 'purchases'),
           ('set_access', 'mock_sets'), ('attempts', 'mock_tests'), ('attempts', 'papers'))`,
    );
    expect(res.rows).toHaveLength(5);
    // 'r' = restrict, 'c' = cascade
    expect(res.rows.map((r) => r.confdeltype)).toEqual(['r', 'r', 'r', 'r', 'r']);
  });

  it('has no teacher DELETE policy left on the four tables', async () => {
    const res = await db.admin.query<{ tablename: string }>(
      `select tablename from pg_policies
       where schemaname = 'public' and cmd = 'DELETE'
         and tablename in ('mock_sets', 'mock_tests', 'papers', 'batches')`,
    );
    expect(res.rows).toEqual([]);
  });
});

describe('(a) a set somebody paid for is archived, never erased', () => {
  it('keeps the purchase, the access row and the buyer results', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    const testId = await insertTest(setId);
    await insertQuestion(teacherA, testId);
    const purchase = await insertPurchase(buyer, setId);
    await grantAccess(buyer, setId);
    const attempt = await insertScoredAttempt(buyer, testId);

    expect(await call(teacherA, 'remove_mock_set', setId)).toBe('archived');

    expect(await archivedAt('mock_sets', setId)).not.toBeNull();
    expect(await count('purchases', 'id = $1', [purchase])).toBe(1);
    expect(await count('set_access', 'set_id = $1', [setId])).toBe(1);
    expect(await count('mock_tests', 'id = $1', [testId])).toBe(1);

    // The buyer still opens the set, the test, the questions and the score.
    await db.asUser(buyer, async (sql) => {
      const sets = await sql.query('select id from public.mock_sets where id = $1', [setId]);
      expect(sets.rows).toHaveLength(1);
      const tests = await sql.query('select id from public.mock_tests where id = $1', [testId]);
      expect(tests.rows).toHaveLength(1);
      const qs = await sql.query('select id from public.questions where test_id = $1', [testId]);
      expect(qs.rows).toHaveLength(1);
      const att = await sql.query<{ score: number }>(
        'select score from public.attempts where id = $1',
        [attempt],
      );
      expect(att.rows[0].score).toBe(7);
    });
  });

  it('hides the archived set from a student who holds nothing, and shows it to its teacher', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await insertTest(setId);
    await grantAccess(buyer, setId);

    expect(await visibleSets(stranger)).toContain(setId);
    await call(teacherA, 'remove_mock_set', setId);

    expect(await visibleSets(stranger)).not.toContain(setId);
    expect(await visibleSets(buyer)).toContain(setId);
    expect(await visibleSets(teacherA)).toContain(setId);
  });

  it('a student who only sat the free sample keeps seeing their result', async () => {
    const setId = await insertSet(teacherA, 'Set with a sample');
    const sample = await insertTest(setId, 1, true);
    await insertQuestion(teacherA, sample);
    await insertScoredAttempt(stranger, sample);

    await call(teacherA, 'remove_mock_set', setId); // an attempt exists -> archived

    expect(await visibleSets(stranger)).toContain(setId);
    await db.asUser(stranger, async (sql) => {
      const qs = await sql.query('select id from public.questions where test_id = $1', [sample]);
      expect(qs.rows).toHaveLength(1);
    });
  });

  it('archives (not deletes) when the only dependent is an expired access row', async () => {
    const setId = await insertSet(teacherA, 'Old access');
    await db.admin.query(
      `insert into public.set_access (user_id, set_id, source, valid_until)
       values ($1, $2, 'admin', now() - interval '1 day')`,
      [buyer, setId],
    );
    expect(await call(teacherA, 'remove_mock_set', setId)).toBe('archived');
  });

  it('is idempotent: removing an archived set again says archived', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await grantAccess(buyer, setId);
    expect(await call(teacherA, 'remove_mock_set', setId)).toBe('archived');
    const first = await archivedAt('mock_sets', setId);
    expect(await call(teacherA, 'remove_mock_set', setId)).toBe('archived');
    expect(await archivedAt('mock_sets', setId)).toEqual(first);
  });
});

describe('(b) an empty set is really deleted', () => {
  it('removes the set and its tests and questions', async () => {
    const setId = await insertSet(teacherA, 'Empty draft', 'draft');
    const testId = await insertTest(setId);
    await insertQuestion(teacherA, testId);

    expect(await call(teacherA, 'remove_mock_set', setId)).toBe('deleted');

    expect(await count('mock_sets', 'id = $1', [setId])).toBe(0);
    expect(await count('mock_tests', 'set_id = $1', [setId])).toBe(0);
    expect(await count('questions', 'test_id = $1', [testId])).toBe(0);
  });

  it('deletes a test nobody sat in a set nobody bought', async () => {
    const setId = await insertSet(teacherA, 'Draft', 'draft');
    const testId = await insertTest(setId);
    expect(await call(teacherA, 'remove_mock_test', testId)).toBe('deleted');
    expect(await count('mock_tests', 'id = $1', [testId])).toBe(0);
    expect(await count('mock_sets', 'id = $1', [setId])).toBe(1);
  });

  it('deletes a paper nobody sat', async () => {
    const paper = await insertPaper(teacherA, 'Shift 1');
    expect(await call(teacherA, 'remove_paper', paper)).toBe('deleted');
    expect(await count('papers', 'id = $1', [paper])).toBe(0);
  });

  it('deletes a batch with no member', async () => {
    const batch = await db.admin.query<{ id: string }>(
      `insert into public.batches (teacher_id, name) values ($1, 'Empty') returning id`,
      [teacherA],
    );
    expect(await call(teacherA, 'remove_batch', batch.rows[0].id)).toBe('deleted');
    expect(await count('batches', 'id = $1', [batch.rows[0].id])).toBe(0);
  });
});

describe('(c) the foreign keys refuse a hard delete underneath', () => {
  it('refuses to delete a set that has a purchase', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await insertPurchase(buyer, setId);
    await expect(
      db.admin.query('delete from public.mock_sets where id = $1', [setId]),
    ).rejects.toThrow(/purchases_set_id_fkey/);
    expect(await count('purchases', 'set_id = $1', [setId])).toBe(1);
  });

  it('refuses to delete a set that has an access row', async () => {
    const setId = await insertSet(teacherA, 'Granted set');
    await grantAccess(buyer, setId, 'admin');
    await expect(
      db.admin.query('delete from public.mock_sets where id = $1', [setId]),
    ).rejects.toThrow(/set_access_set_id_fkey/);
  });

  it('refuses to delete a set whose test has a score (through mock_tests)', async () => {
    const setId = await insertSet(teacherA, 'Scored set');
    const testId = await insertTest(setId);
    await insertScoredAttempt(buyer, testId);
    await expect(
      db.admin.query('delete from public.mock_sets where id = $1', [setId]),
    ).rejects.toThrow(/attempts_test_fkey/);
    expect(await count('attempts', 'test_id = $1', [testId])).toBe(1);
  });

  it('refuses to delete a paper that has a score', async () => {
    const paper = await insertPaper(teacherA, 'Shift 1');
    await db.admin.query(
      `insert into public.attempts (user_id, paper_id, mode, submitted_at, score)
       values ($1, $2, 'practice', now(), 5)`,
      [buyer, paper],
    );
    await expect(
      db.admin.query('delete from public.papers where id = $1', [paper]),
    ).rejects.toThrow(/attempts_paper_id_fkey/);
  });

  it('refuses to delete a purchase that has a ledger row', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    const purchase = await insertPurchase(buyer, setId);
    await db.admin.query(
      `insert into public.teacher_ledger
         (teacher_id, purchase_id, gross, gst, gateway_fee, net, share_pct, teacher_amount, platform_amount)
       values ($1, $2, 299, 45.61, 5.00, 248.39, 50, 124.19, 124.20)`,
      [teacherA, purchase],
    );
    await expect(
      db.admin.query('delete from public.purchases where id = $1', [purchase]),
    ).rejects.toThrow(/teacher_ledger_purchase_id_fkey/);
  });

  it('a teacher can no longer delete rows directly (no policy)', async () => {
    const setId = await insertSet(teacherA, 'Draft', 'draft');
    const paper = await insertPaper(teacherA, 'Shift 1');
    await db.asUser(teacherA, async (sql) => {
      await sql.query('delete from public.mock_sets where id = $1', [setId]);
      await sql.query('delete from public.papers where id = $1', [paper]);
    });
    expect(await count('mock_sets', 'id = $1', [setId])).toBe(1);
    expect(await count('papers', 'id = $1', [paper])).toBe(1);
  });

  it('a teacher cannot flip archived_at by hand to dodge the 30 day window', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_set', setId);
    await ageArchive('mock_sets', setId, 40);

    await expect(
      db.asUser(teacherA, async (sql) => {
        await sql.query('update public.mock_sets set archived_at = null where id = $1', [setId]);
      }),
    ).rejects.toThrow(/remove and restore/);
    expect(await archivedAt('mock_sets', setId)).not.toBeNull();
  });
});

describe('(d) a stranger cannot remove or restore', () => {
  it('answers "not found" for all four objects and changes nothing', async () => {
    const setId = await insertSet(teacherA, 'Mine');
    const testId = await insertTest(setId);
    const paper = await insertPaper(teacherA, 'Shift 1');
    const batch = (
      await db.admin.query<{ id: string }>(
        `insert into public.batches (teacher_id, name) values ($1, 'B') returning id`,
        [teacherA],
      )
    ).rows[0].id;

    for (const [fn, id] of [
      ['remove_mock_set', setId],
      ['remove_mock_test', testId],
      ['remove_paper', paper],
      ['remove_batch', batch],
      ['restore_mock_set', setId],
      ['restore_mock_test', testId],
      ['restore_paper', paper],
      ['restore_batch', batch],
    ] as const) {
      await expect(call(teacherB, fn, id)).rejects.toThrow(/not found/);
      await expect(call(stranger, fn, id)).rejects.toThrow(/not found/);
    }

    expect(await count('mock_sets', 'id = $1', [setId])).toBe(1);
    expect(await count('mock_tests', 'id = $1', [testId])).toBe(1);
    expect(await count('papers', 'id = $1', [paper])).toBe(1);
    expect(await count('batches', 'id = $1', [batch])).toBe(1);
  });

  it('cannot restore someone else\'s archived set', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_set', setId);
    await expect(call(teacherB, 'restore_mock_set', setId)).rejects.toThrow(/not found/);
    expect(await archivedAt('mock_sets', setId)).not.toBeNull();
  });

  it('refuses a caller who is not signed in', async () => {
    const setId = await insertSet(teacherA, 'Mine');
    await expect(
      db.asAnon(async (sql) => {
        await sql.query('select public.remove_mock_set($1)', [setId]);
      }),
    ).rejects.toThrow();
  });
});

describe('(e) the 30 day restore window', () => {
  it('restores within the window', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_set', setId);
    await ageArchive('mock_sets', setId, 29);

    expect(await call(teacherA, 'restore_mock_set', setId)).toBe('restored');
    expect(await archivedAt('mock_sets', setId)).toBeNull();
  });

  it('refuses a restore after 31 days', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_set', setId);
    await ageArchive('mock_sets', setId, 31);

    await expect(call(teacherA, 'restore_mock_set', setId)).rejects.toThrow(/30 day/);
    expect(await archivedAt('mock_sets', setId)).not.toBeNull();
  });

  it('applies to tests, papers and batches too', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    const testId = await insertTest(setId);
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_test', testId);
    await ageArchive('mock_tests', testId, 31);
    await expect(call(teacherA, 'restore_mock_test', testId)).rejects.toThrow(/30 day/);

    const paper = await insertPaper(teacherA, 'Shift 1');
    await db.admin.query(
      `insert into public.attempts (user_id, paper_id, mode) values ($1, $2, 'practice')`,
      [buyer, paper],
    );
    await call(teacherA, 'remove_paper', paper);
    await ageArchive('papers', paper, 31);
    await expect(call(teacherA, 'restore_paper', paper)).rejects.toThrow(/30 day/);
  });
});

describe('(f) an archived test refuses a new attempt', () => {
  it('an archived test in a sold set takes no new sitting, old results stay', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    const testId = await insertTest(setId);
    const other = await insertTest(setId, 2);
    await grantAccess(buyer, setId);
    const old = await insertScoredAttempt(buyer, testId);

    expect(await call(teacherA, 'remove_mock_test', testId)).toBe('archived');

    await expect(
      db.asUser(buyer, async (sql) => {
        await sql.query(
          `insert into public.attempts (user_id, test_id, mode) values ($1, $2, 'practice')`,
          [buyer, testId],
        );
      }),
    ).rejects.toThrow(/row-level security/);

    // The sibling test is untouched, and the old score is still there.
    await db.asUser(buyer, async (sql) => {
      await sql.query(
        `insert into public.attempts (user_id, test_id, mode) values ($1, $2, 'practice')`,
        [buyer, other],
      );
      const kept = await sql.query('select id from public.attempts where id = $1', [old]);
      expect(kept.rows).toHaveLength(1);
    });
  });

  it('a test inside an archived set takes no new sitting either', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    const testId = await insertTest(setId);
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_set', setId);

    await expect(
      db.asUser(buyer, async (sql) => {
        await sql.query(
          `insert into public.attempts (user_id, test_id, mode) values ($1, $2, 'practice')`,
          [buyer, testId],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('an archived paper takes no new sitting; its old results stay visible', async () => {
    const paper = await insertPaper(teacherA, 'Shift 1');
    const old = await db.admin.query<{ id: string }>(
      `insert into public.attempts (user_id, paper_id, mode, submitted_at, score)
       values ($1, $2, 'practice', now(), 9) returning id`,
      [buyer, paper],
    );
    expect(await call(teacherA, 'remove_paper', paper)).toBe('archived');

    await expect(
      db.asUser(stranger, async (sql) => {
        await sql.query(
          `insert into public.attempts (user_id, paper_id, mode) values ($1, $2, 'practice')`,
          [stranger, paper],
        );
      }),
    ).rejects.toThrow();

    await db.asUser(buyer, async (sql) => {
      const papers = await sql.query('select id from public.papers where id = $1', [paper]);
      expect(papers.rows).toHaveLength(1);
      const att = await sql.query('select id from public.attempts where id = $1', [
        old.rows[0].id,
      ]);
      expect(att.rows).toHaveLength(1);
    });
    // Someone who never sat it no longer sees it in the list.
    await db.asUser(stranger, async (sql) => {
      const papers = await sql.query('select id from public.papers where id = $1', [paper]);
      expect(papers.rows).toHaveLength(0);
    });
  });
});

describe('an archived set cannot be bought', () => {
  it('refuses a new purchase row with the usual "not found" code', async () => {
    const setId = await insertSet(teacherA, 'Sold set');
    await grantAccess(buyer, setId);
    await call(teacherA, 'remove_mock_set', setId);

    await expect(
      db.asUser(stranger, async (sql) => {
        await sql.query('select * from public.start_set_purchase($1)', [setId]);
      }),
    ).rejects.toThrow(/mock set not found/);
    expect(await count('purchases', 'user_id = $1', [stranger])).toBe(0);
  });
});

describe('batches', () => {
  async function makeBatch(setId: string): Promise<{ id: string; code: string }> {
    const res = await db.asUser(teacherA, async (sql) => {
      const b = await sql.query<{ id: string; join_code: string }>(
        `insert into public.batches (teacher_id, name) values ($1, 'Morning') returning id, join_code`,
        [teacherA],
      );
      await sql.query('insert into public.batch_sets (batch_id, set_id) values ($1, $2)', [
        b.rows[0].id,
        setId,
      ]);
      return { id: b.rows[0].id, code: b.rows[0].join_code };
    });
    return res;
  }

  function joinAs(user: string, code: string): Promise<void> {
    return db.asUser(user, async (sql) => {
      await sql.query('select public.join_batch($1)', [code]);
    });
  }

  function batchGrants(user: string): Promise<number> {
    return count('set_access', `user_id = $1 and source = 'batch'`, [user]);
  }

  it('archiving withdraws the batch set_access, keeps a purchase, and keeps the reports', async () => {
    const setId = await insertSet(teacherA, 'Free set');
    const testId = await insertTest(setId);
    const batch = await makeBatch(setId);
    await joinAs(buyer, batch.code);
    await grantAccess(buyer, setId, 'purchase'); // also bought it themselves
    await insertScoredAttempt(buyer, testId);
    expect(await batchGrants(buyer)).toBe(1);

    expect(await call(teacherA, 'remove_batch', batch.id)).toBe('archived');

    expect(await batchGrants(buyer)).toBe(0);
    expect(await count('set_access', `user_id = $1 and source = 'purchase'`, [buyer])).toBe(1);
    expect(await count('batch_members', 'batch_id = $1', [batch.id])).toBe(1);

    // The report views still answer for the teacher.
    const scores = await db.asUser(teacherA, async (sql) => {
      const r = await sql.query<{ score: number }>(
        'select score from public.batch_report_scores where batch_id = $1',
        [batch.id],
      );
      return r.rows;
    });
    expect(scores).toEqual([{ score: 7 }]);
    const tests = await db.asUser(teacherA, async (sql) => {
      const r = await sql.query('select test_id from public.batch_report_tests where batch_id = $1', [
        batch.id,
      ]);
      return r.rows;
    });
    expect(tests).toHaveLength(1);
  });

  it('a member of an archived batch loses the batch and cannot read the set questions', async () => {
    const setId = await insertSet(teacherA, 'Free set');
    const testId = await insertTest(setId);
    await insertQuestion(teacherA, testId);
    const batch = await makeBatch(setId);
    await joinAs(buyer, batch.code);

    const readable = () =>
      db.asUser(buyer, async (sql) => {
        const r = await sql.query('select id from public.questions where test_id = $1', [testId]);
        return r.rows.length;
      });
    expect(await readable()).toBe(1);

    await call(teacherA, 'remove_batch', batch.id);
    expect(await readable()).toBe(0);

    await db.asUser(buyer, async (sql) => {
      const r = await sql.query('select id from public.batches where id = $1', [batch.id]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it('restoring brings the batch grants back', async () => {
    const setId = await insertSet(teacherA, 'Free set');
    const batch = await makeBatch(setId);
    await joinAs(buyer, batch.code);
    await call(teacherA, 'remove_batch', batch.id);
    expect(await batchGrants(buyer)).toBe(0);

    expect(await call(teacherA, 'restore_batch', batch.id)).toBe('restored');
    expect(await batchGrants(buyer)).toBe(1);
  });

  it('nobody can join an archived batch', async () => {
    const setId = await insertSet(teacherA, 'Free set');
    const batch = await makeBatch(setId);
    await joinAs(buyer, batch.code);
    await call(teacherA, 'remove_batch', batch.id);

    await expect(joinAs(stranger, batch.code)).rejects.toThrow(/join code/i);
    expect(await count('batch_members', 'user_id = $1', [stranger])).toBe(0);
  });
});
