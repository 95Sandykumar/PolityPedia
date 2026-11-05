/**
 * Teacher notification posts (issue 09-teacher-notifications).
 *
 * V17 / PRD F-H1: a teacher posts a notice (priority, heading, link) and it
 * shows at the top of the Notifications tile. The nightly news (v0) comes
 * later and sits below these.
 *
 * The proofs the issue asks for, at the layer that really decides them:
 *
 *  1. ORDERING: highest priority first, then newest first.
 *  2. teacher B cannot delete (or edit, or forge) teacher A's post.
 *  3. a signed-in student reads an APPROVED teacher's posts; a teacher who is
 *     still waiting for an admin is invisible, the same rule as `follows`.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher. The author in nearly every test. */
let teacherA: string;
/** A second approved teacher. The attacker in the "another teacher" tests. */
let teacherB: string;
/** Redeemed an invite, still waiting for an admin. Posts must stay hidden. */
let pendingTeacher: string;
/** A plain signed-in student. Reads, never writes. */
let student: string;

beforeAll(async () => {
  db = await createTestDb();

  teacherA = await db.createUser();
  teacherB = await db.createUser();
  pendingTeacher = await db.createUser();
  student = await db.createUser();

  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status)
     values ($1, 'alias', 'Polity Guru', 'approved'),
            ($2, 'alias', 'Second Guru', 'approved'),
            ($3, 'alias', 'Newcomer',    'pending')`,
    [teacherA, teacherB, pendingTeacher],
  );
});

afterAll(async () => {
  await db?.close();
});

/** Insert straight past RLS, with a fixed date so ordering is deterministic. */
async function seedPost(input: {
  teacherId: string;
  heading: string;
  priority?: number;
  link?: string | null;
  createdAt?: string;
}): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.teacher_posts (teacher_id, heading, priority, link, created_at)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))
     returning id`,
    [
      input.teacherId,
      input.heading,
      input.priority ?? 0,
      input.link ?? null,
      input.createdAt ?? null,
    ],
  );
  return res.rows[0].id;
}

async function countPosts(teacherId: string): Promise<number> {
  const res = await db.admin.query<{ n: number }>(
    'select count(*)::int as n from public.teacher_posts where teacher_id = $1',
    [teacherId],
  );
  return res.rows[0].n;
}

async function clearPosts(): Promise<void> {
  await db.admin.query('delete from public.teacher_posts');
}

describe('0009_teacher_posts.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0009_teacher_posts.sql');
  });

  it('has row level security on', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.teacher_posts'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('refuses a blank heading', async () => {
    await expect(seedPost({ teacherId: teacherA, heading: '   ' })).rejects.toThrow();
  });

  it('refuses a link that is not http or https', async () => {
    await expect(
      seedPost({ teacherId: teacherA, heading: 'Trap', link: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    await clearPosts();
  });

  it('refuses a priority outside the allowed range', async () => {
    await expect(
      seedPost({ teacherId: teacherA, heading: 'Too loud', priority: 9 }),
    ).rejects.toThrow();
    await clearPosts();
  });

  it('drops the posts when the teacher account is deleted', async () => {
    const leaving = await db.createUser();
    await db.admin.query(
      `insert into public.teachers (user_id, identity_mode, alias, status)
       values ($1, 'alias', 'Leaving', 'approved')`,
      [leaving],
    );
    await seedPost({ teacherId: leaving, heading: 'Bye' });
    expect(await countPosts(leaving)).toBe(1);

    await db.admin.query('delete from auth.users where id = $1', [leaving]);
    expect(await countPosts(leaving)).toBe(0);
  });
});

describe('ordering', () => {
  it('puts the highest priority first, then the newest first', async () => {
    await clearPosts();
    // Deliberately inserted in the WRONG order, so a passing test cannot be
    // insertion order wearing a disguise.
    await seedPost({
      teacherId: teacherA,
      heading: 'old normal',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedPost({
      teacherId: teacherA,
      heading: 'new normal',
      priority: 0,
      createdAt: '2026-03-01T00:00:00Z',
    });
    await seedPost({
      teacherId: teacherA,
      heading: 'old urgent',
      priority: 2,
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedPost({
      teacherId: teacherA,
      heading: 'new important',
      priority: 1,
      createdAt: '2026-04-01T00:00:00Z',
    });

    const headings = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ heading: string }>(
        `select heading from public.teacher_posts
          where teacher_id = $1
          order by priority desc, created_at desc`,
        [teacherA],
      );
      return res.rows.map((r) => r.heading);
    });

    expect(headings).toEqual(['old urgent', 'new important', 'new normal', 'old normal']);
    await clearPosts();
  });
});

describe('a teacher and their own posts', () => {
  it('writes, reads and deletes its own post', async () => {
    const own = await db.asUser(teacherA, async (sql) => {
      const made = await sql.query<{ id: string }>(
        `insert into public.teacher_posts (teacher_id, heading, priority, link)
         values ($1, 'NET form is out', 1, 'https://ugcnet.nta.ac.in')
         returning id`,
        [teacherA],
      );
      const read = await sql.query<{ heading: string }>(
        'select heading from public.teacher_posts where teacher_id = $1',
        [teacherA],
      );
      return { id: made.rows[0].id, headings: read.rows.map((r) => r.heading) };
    });
    expect(own.headings).toEqual(['NET form is out']);
    expect(await countPosts(teacherA)).toBe(1);

    await db.asUser(teacherA, async (sql) => {
      await sql.query('delete from public.teacher_posts where id = $1', [own.id]);
    });
    expect(await countPosts(teacherA)).toBe(0);
  });

  it('refuses a post written in another teachers name', async () => {
    await expect(
      db.asUser(teacherB, async (sql) => {
        await sql.query(
          `insert into public.teacher_posts (teacher_id, heading) values ($1, 'Fake notice')`,
          [teacherA],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await countPosts(teacherA)).toBe(0);
  });

  it('refuses a post from somebody who is not a teacher at all', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          `insert into public.teacher_posts (teacher_id, heading) values ($1, 'Student notice')`,
          [student],
        );
      }),
    ).rejects.toThrow();

    expect(await countPosts(student)).toBe(0);
  });
});

describe('another teacher', () => {
  it('cannot delete teacher As post', async () => {
    const id = await seedPost({ teacherId: teacherA, heading: 'Mine, not yours' });

    await db.asUser(teacherB, async (sql) => {
      await sql.query('delete from public.teacher_posts where id = $1', [id]);
    });
    // The delete silently matched no row, because the policy hid it.
    expect(await countPosts(teacherA)).toBe(1);

    await clearPosts();
  });

  it('cannot edit teacher As post', async () => {
    const id = await seedPost({ teacherId: teacherA, heading: 'Original' });

    await db.asUser(teacherB, async (sql) => {
      await sql.query(`update public.teacher_posts set heading = 'Hijacked' where id = $1`, [id]);
    });

    const res = await db.admin.query<{ heading: string }>(
      'select heading from public.teacher_posts where id = $1',
      [id],
    );
    expect(res.rows[0].heading).toBe('Original');

    await clearPosts();
  });

  it('cannot move a post of its own over to teacher A', async () => {
    const id = await seedPost({ teacherId: teacherB, heading: 'Belongs to B' });

    await expect(
      db.asUser(teacherB, async (sql) => {
        await sql.query('update public.teacher_posts set teacher_id = $1 where id = $2', [
          teacherA,
          id,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await countPosts(teacherA)).toBe(0);
    await clearPosts();
  });
});

describe('who may read', () => {
  it('lets any signed-in user read an approved teachers posts', async () => {
    await seedPost({ teacherId: teacherA, heading: 'Open to students' });

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query<{ heading: string }>('select heading from public.teacher_posts');
      return res.rows.map((r) => r.heading);
    });
    expect(seen).toEqual(['Open to students']);

    await clearPosts();
  });

  it('hides the posts of a teacher who is still waiting for approval', async () => {
    await seedPost({ teacherId: pendingTeacher, heading: 'Not approved yet' });

    const seen = await db.asUser(student, async (sql) => {
      const res = await sql.query('select heading from public.teacher_posts');
      return res.rows;
    });
    expect(seen).toEqual([]);

    // The author still sees their own drafts, so the teacher page is not blank
    // while they wait for an admin.
    const mine = await db.asUser(pendingTeacher, async (sql) => {
      const res = await sql.query<{ heading: string }>('select heading from public.teacher_posts');
      return res.rows.map((r) => r.heading);
    });
    expect(mine).toEqual(['Not approved yet']);

    await clearPosts();
  });
});

describe('anon', () => {
  it('sees nothing and cannot insert', async () => {
    await seedPost({ teacherId: teacherA, heading: 'Signed in only' });

    const seen = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.teacher_posts');
      return res.rows;
    });
    expect(seen).toEqual([]);

    await expect(
      db.asAnon(async (sql) => {
        await sql.query(
          `insert into public.teacher_posts (teacher_id, heading) values ($1, 'Anon notice')`,
          [teacherA],
        );
      }),
    ).rejects.toThrow();

    await clearPosts();
  });
});
