/**
 * `teacher_cards`, the Teachers list row (issue 67a-teachers-reader-filter).
 *
 * The view answers two questions the list could not ask cheaply:
 *  - does this teacher have a FREE SAMPLE test to try?
 *  - which exams do they teach, so the list can be cut to the student's own?
 *
 * WHY OWNER'S RIGHTS. The badge is a public claim, so every reader must see
 * the same one. The view therefore spells the rule out instead of leaning on
 * RLS: a LIVE, non-archived set with a non-archived free sample test. These
 * tests are the proof, because with the caller's rights a teacher's own DRAFT
 * set and a buyer's ARCHIVED set would each light the badge for one person.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` and
 * `db.asAnon`, where Postgres evaluates every policy and grant for real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Two exams from the 0004 seed, by their fixed ids. */
const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

/** The person the list is drawn for. */
let student = '';

/** Approved. A live set with a free sample test: the only badge in this file. */
let hasFree = '';
/** Approved. The same free sample test, but the set is still a DRAFT. */
let draftSet = '';
/** Approved. A live set that has been archived. */
let archivedSet = '';
/** Approved. A live set whose free sample TEST was archived. */
let archivedTest = '';
/** Approved. A live set, but no test on it is the free sample. */
let noSample = '';
/** Approved, and has listed no exam at all. */
let noExams = '';
/** NOT approved, and has a live set with a free sample. Must not be listed. */
let pending = '';

interface CardRow {
  user_id: string;
  display_name: string;
  has_free_sample: boolean;
  exam_ids: string[];
}

async function addTeacher(alias: string, status: 'approved' | 'pending'): Promise<string> {
  const userId = await db.createUser();
  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', $2, $3)`,
    [userId, alias, status],
  );
  return userId;
}

async function teaches(teacherId: string, examId: string): Promise<void> {
  await db.admin.query(`insert into public.teacher_exams (teacher_id, exam_id) values ($1, $2)`, [
    teacherId,
    examId,
  ]);
}

/**
 * One set and one test, inserted straight in. `archived_at` is set on INSERT
 * on purpose: `archive_guard` (0041) is a BEFORE UPDATE trigger, so there is
 * nothing to dodge and no `remove_*` call to fake.
 */
async function addSet(
  teacherId: string,
  options: {
    examId?: string;
    status?: 'draft' | 'live';
    setArchived?: boolean;
    freeSample?: boolean;
    testArchived?: boolean;
  } = {},
): Promise<string> {
  const set = await db.admin.query<{ id: string }>(
    `insert into public.mock_sets (teacher_id, exam_id, title, status, archived_at)
     values ($1, $2, 'Full length set 1', $3,
             case when $4::boolean then now() else null end)
     returning id`,
    [teacherId, options.examId ?? NET, options.status ?? 'live', options.setArchived ?? false],
  );
  const setId = set.rows[0].id;

  await db.admin.query(
    `insert into public.mock_tests (set_id, title, position, is_free_sample, archived_at)
     values ($1, 'Test 1', 1, $2, case when $3::boolean then now() else null end)`,
    [setId, options.freeSample ?? true, options.testArchived ?? false],
  );
  return setId;
}

/** The whole view as the given caller reads it, by teacher id. */
function cardsFor(userId: string): Promise<Map<string, CardRow>> {
  return db.asUser(userId, async (sql) => {
    const res = await sql.query<CardRow>(
      `select user_id, display_name, has_free_sample, exam_ids from public.teacher_cards`,
    );
    return new Map(res.rows.map((row) => [row.user_id, row]));
  });
}

beforeAll(async () => {
  db = await createTestDb();

  student = await db.createUser();

  hasFree = await addTeacher('Bina Das', 'approved');
  await teaches(hasFree, NET);
  await addSet(hasFree);

  draftSet = await addTeacher('Amit Rao', 'approved');
  await teaches(draftSet, NET);
  await addSet(draftSet, { status: 'draft' });

  archivedSet = await addTeacher('Chandra Iyer', 'approved');
  await teaches(archivedSet, CUET);
  await addSet(archivedSet, { examId: CUET, setArchived: true });

  archivedTest = await addTeacher('Divya Nair', 'approved');
  await teaches(archivedTest, NET);
  await teaches(archivedTest, CUET);
  await addSet(archivedTest, { testArchived: true });

  noSample = await addTeacher('Esha Roy', 'approved');
  await teaches(noSample, CUET);
  await addSet(noSample, { examId: CUET, freeSample: false });

  noExams = await addTeacher('Farah Shah', 'approved');
  await addSet(noExams, { freeSample: false });

  pending = await addTeacher('Waiting Guru', 'pending');
  await teaches(pending, NET);
  await addSet(pending);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('has_free_sample: the badge', () => {
  it('is true for a LIVE, non-archived set with a non-archived free sample test', async () => {
    const cards = await cardsFor(student);
    expect(cards.get(hasFree)?.has_free_sample).toBe(true);
  });

  it('is false for a DRAFT set, so an unpublished set never advertises itself', async () => {
    const cards = await cardsFor(student);
    expect(cards.get(draftSet)?.has_free_sample).toBe(false);
  });

  it('is false for an ARCHIVED set', async () => {
    const cards = await cardsFor(student);
    expect(cards.get(archivedSet)?.has_free_sample).toBe(false);
  });

  it('is false when the free sample TEST itself was archived', async () => {
    const cards = await cardsFor(student);
    expect(cards.get(archivedTest)?.has_free_sample).toBe(false);
  });

  it('is false for a live set whose tests are all paid', async () => {
    const cards = await cardsFor(student);
    expect(cards.get(noSample)?.has_free_sample).toBe(false);
  });

  it('reads the SAME for the teacher who owns the draft set as for a student', async () => {
    // The point of owner's rights: `mock_sets_select_live` lets this teacher
    // select their own draft, so the caller's rights would light their badge.
    const cards = await cardsFor(draftSet);
    expect(cards.get(draftSet)?.has_free_sample).toBe(false);
  });
});

describe('who is in the list', () => {
  it('lists approved teachers only: a pending teacher with a free sample is absent', async () => {
    const cards = await cardsFor(student);

    expect(cards.has(pending)).toBe(false);
    expect(cards.size).toBe(6);
  });

  it('has no real_name column at all, so a page cannot show one by accident', async () => {
    const res = await db.admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'teacher_cards'`,
    );
    const columns = res.rows.map((row) => row.column_name);

    expect(columns).not.toContain('real_name');
    expect(columns).not.toContain('photo_path');
    expect(columns).toContain('display_name');
    expect(columns).toContain('has_free_sample');
    expect(columns).toContain('exam_ids');
  });

  it('is refused to an anonymous visitor: the grant is `authenticated` only', async () => {
    await expect(
      db.asAnon((sql) => sql.query(`select user_id from public.teacher_cards`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is read only: a student cannot write a teacher row through it', async () => {
    await expect(
      db.asUser(student, (sql) =>
        sql.query(`update public.teacher_cards set display_name = 'Hacked'`),
      ),
    ).rejects.toThrow();
  });
});

describe('exam_ids: what the exam filter matches on', () => {
  it('holds the exams the teacher listed', async () => {
    const cards = await cardsFor(student);

    expect(cards.get(hasFree)?.exam_ids).toEqual([NET]);
    expect(cards.get(archivedTest)?.exam_ids?.slice().sort()).toEqual([NET, CUET].sort());
  });

  it('is an empty array, never NULL, for a teacher who listed no exam', async () => {
    const cards = await cardsFor(student);
    expect(cards.get(noExams)?.exam_ids).toEqual([]);
  });

  it('overlaps: ONE query returns only the teachers of the chosen exams', async () => {
    const found = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ user_id: string }>(
        `select user_id from public.teacher_cards where exam_ids && $1::text[]`,
        [[NET]],
      );
      return res.rows.map((row) => row.user_id);
    });

    expect(found.slice().sort()).toEqual([hasFree, draftSet, archivedTest].sort());
  });

  it('matches the same rows for a plain {uuid} literal, which is what PostgREST sends', async () => {
    const count = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ n: number }>(
        `select count(*)::int as n from public.teacher_cards
         where exam_ids && '{${NET}}'`,
      );
      return Number(res.rows[0].n);
    });

    expect(count).toBe(3);
  });
});

describe('order: a free sample first, then A to Z', () => {
  it('sorts in Postgres, so a long list costs the page nothing', async () => {
    const names = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ display_name: string }>(
        `select display_name from public.teacher_cards
         order by has_free_sample desc, display_name asc`,
      );
      return res.rows.map((row) => row.display_name);
    });

    expect(names).toEqual([
      'Bina Das',
      'Amit Rao',
      'Chandra Iyer',
      'Divya Nair',
      'Esha Roy',
      'Farah Shah',
    ]);
  });
});
