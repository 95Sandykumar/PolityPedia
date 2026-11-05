/**
 * Teacher videos and the Show / No show switch (issue 08-videos-tile).
 *
 * The one rule the issue turns on (V6, PRD F-C2): a student reads a teacher's
 * videos ONLY while `teachers.videos_visible` is true. That is enforced HERE,
 * in Postgres, not in a page: the select policy asks `teachers_public`, which
 * already filters `status = 'approved'` and carries `videos_visible`.
 *
 * The proofs:
 *  1. videos_visible TRUE  -> the student sees the rows.
 *  2. videos_visible FALSE -> the student query returns 0 ROWS.
 *  3. a teacher always reads and writes their OWN rows, No show included.
 *  4. one teacher cannot touch another teacher's videos.
 *  5. a pending teacher's videos stay invisible, like their portfolio.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (Postgres
 * evaluates every policy for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

let db: TestDb;

/** Approved teacher, videos_visible true. The happy path. */
let shown: string;
/** Approved teacher who switched Videos to No show. */
let hidden: string;
/** Redeemed an invite, still waiting for an admin. */
let pending: string;
/** The student in every test below. */
let student: string;

async function addTeacher(
  userId: string,
  alias: string,
  status: 'approved' | 'pending',
  videosVisible: boolean,
): Promise<void> {
  await db.admin.query(
    `insert into public.teachers (user_id, identity_mode, alias, status, videos_visible)
     values ($1, 'alias', $2, $3, $4)`,
    [userId, alias, status, videosVisible],
  );
}

async function addVideo(teacherId: string, youtubeId: string, position: number): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into public.teacher_videos (teacher_id, youtube_id, title, thumb_url, "position")
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      teacherId,
      youtubeId,
      'Polity class ' + position,
      `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      position,
    ],
  );
  return res.rows[0].id;
}

/** What a student really gets back for one teacher. The DoD query. */
function studentSees(teacherId: string): Promise<string[]> {
  return db.asUser(student, async (sql) => {
    const res = await sql.query<{ youtube_id: string }>(
      `select youtube_id from public.teacher_videos
       where teacher_id = $1 order by "position" asc`,
      [teacherId],
    );
    return res.rows.map((r) => r.youtube_id);
  });
}

async function countVideos(teacherId: string): Promise<number> {
  const res = await db.admin.query<{ n: number }>(
    'select count(*)::int as n from public.teacher_videos where teacher_id = $1',
    [teacherId],
  );
  return res.rows[0].n;
}

beforeAll(async () => {
  db = await createTestDb();

  shown = await db.createUser();
  hidden = await db.createUser();
  pending = await db.createUser();
  student = await db.createUser();

  await addTeacher(shown, 'Polity Guru', 'approved', true);
  await addTeacher(hidden, 'Quiet Sir', 'approved', false);
  await addTeacher(pending, 'Newcomer', 'pending', true);

  await addVideo(shown, 'dQw4w9WgXcQ', 0);
  await addVideo(shown, 'aaaaaaaaaaa', 1);
  await addVideo(hidden, 'bbbbbbbbbbb', 0);
  await addVideo(pending, 'ccccccccccc', 0);
});

afterAll(async () => {
  await db?.close();
});

describe('0008_videos.sql', () => {
  it('is applied by the harness', () => {
    expect(db.migrations).toContain('0008_videos.sql');
  });

  it('has row level security on', async () => {
    const res = await db.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.teacher_videos'::regclass`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('refuses the same video twice for one teacher', async () => {
    await expect(addVideo(shown, 'dQw4w9WgXcQ', 9)).rejects.toThrow();

    // The same video under a different teacher is fine: each keeps their own.
    const extra = await db.createUser();
    await addTeacher(extra, 'Second Sir', 'approved', true);
    await expect(addVideo(extra, 'dQw4w9WgXcQ', 0)).resolves.toBeTruthy();
    await db.admin.query('delete from auth.users where id = $1', [extra]);
  });

  it('drops the videos when the teacher account is deleted', async () => {
    const extra = await db.createUser();
    await addTeacher(extra, 'Leaving', 'approved', true);
    await addVideo(extra, 'ddddddddddd', 0);
    expect(await countVideos(extra)).toBe(1);

    await db.admin.query('delete from auth.users where id = $1', [extra]);
    expect(await countVideos(extra)).toBe(0);
  });
});

describe('a student reading videos', () => {
  it('sees the rows of a teacher whose Videos are on Show, in order', async () => {
    expect(await studentSees(shown)).toEqual(['dQw4w9WgXcQ', 'aaaaaaaaaaa']);
  });

  it('gets 0 rows once the teacher switches Videos to No show', async () => {
    expect(await studentSees(hidden)).toEqual([]);
    // The rows are still stored. Only the read is closed, so switching back
    // to Show brings the same list back.
    expect(await countVideos(hidden)).toBe(1);
  });

  it('follows the switch both ways in one session', async () => {
    await db.admin.query('update public.teachers set videos_visible = true where user_id = $1', [
      hidden,
    ]);
    expect(await studentSees(hidden)).toEqual(['bbbbbbbbbbb']);

    await db.admin.query('update public.teachers set videos_visible = false where user_id = $1', [
      hidden,
    ]);
    expect(await studentSees(hidden)).toEqual([]);
  });

  it('sees nothing from a teacher who is still waiting for approval', async () => {
    expect(await studentSees(pending)).toEqual([]);
  });

  it('cannot add, change or delete another teacher videos', async () => {
    await expect(
      db.asUser(student, async (sql) => {
        await sql.query(
          'insert into public.teacher_videos (teacher_id, youtube_id) values ($1, $2)',
          [shown, 'eeeeeeeeeee'],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    await db.asUser(student, async (sql) => {
      await sql.query('delete from public.teacher_videos where teacher_id = $1', [shown]);
      await sql.query('update public.teacher_videos set title = $1 where teacher_id = $2', [
        'hacked',
        shown,
      ]);
    });
    expect(await countVideos(shown)).toBe(2);

    const titles = await db.admin.query<{ title: string }>(
      'select title from public.teacher_videos where teacher_id = $1',
      [shown],
    );
    expect(titles.rows.every((r) => r.title !== 'hacked')).toBe(true);
  });
});

describe('a teacher managing their own videos', () => {
  it('adds, lists and deletes their own rows', async () => {
    const listed = await db.asUser(shown, async (sql) => {
      await sql.query(
        `insert into public.teacher_videos (teacher_id, youtube_id, title, thumb_url, "position")
         values ($1, 'fffffffffff', 'New class', 'https://i.ytimg.com/vi/fffffffffff/hqdefault.jpg', 2)`,
        [shown],
      );
      const res = await sql.query<{ youtube_id: string }>(
        'select youtube_id from public.teacher_videos order by "position" asc',
      );
      return res.rows.map((r) => r.youtube_id);
    });
    expect(listed).toEqual(['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'fffffffffff']);

    await db.asUser(shown, async (sql) => {
      await sql.query('delete from public.teacher_videos where youtube_id = $1', ['fffffffffff']);
    });
    expect(await countVideos(shown)).toBe(2);
  });

  it('still reads its own list while Videos are on No show', async () => {
    const own = await db.asUser(hidden, async (sql) => {
      const res = await sql.query<{ youtube_id: string }>(
        'select youtube_id from public.teacher_videos where teacher_id = $1',
        [hidden],
      );
      return res.rows.map((r) => r.youtube_id);
    });
    // The owner policy is OR'd with the student one, so No show never locks a
    // teacher out of the list they just hid.
    expect(own).toEqual(['bbbbbbbbbbb']);
  });

  it('reads another teacher videos only as a student would', async () => {
    const seen = await db.asUser(hidden, async (sql) => {
      const res = await sql.query<{ youtube_id: string }>(
        'select youtube_id from public.teacher_videos where teacher_id = $1',
        [pending],
      );
      return res.rows.map((r) => r.youtube_id);
    });
    expect(seen).toEqual([]);
  });

  it('flips its own Show / No show switch', async () => {
    await db.asUser(hidden, async (sql) => {
      await sql.query('update public.teachers set videos_visible = true where user_id = $1', [
        hidden,
      ]);
    });
    const res = await db.admin.query<{ videos_visible: boolean }>(
      'select videos_visible from public.teachers where user_id = $1',
      [hidden],
    );
    expect(res.rows[0].videos_visible).toBe(true);

    await db.admin.query('update public.teachers set videos_visible = false where user_id = $1', [
      hidden,
    ]);
  });

  it('refuses a row that names another teacher', async () => {
    await expect(
      db.asUser(shown, async (sql) => {
        await sql.query(
          'insert into public.teacher_videos (teacher_id, youtube_id) values ($1, $2)',
          [hidden, 'ggggggggggg'],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await countVideos(hidden)).toBe(1);
  });

  it('cannot move a row of theirs onto another teacher', async () => {
    await expect(
      db.asUser(shown, async (sql) => {
        await sql.query('update public.teacher_videos set teacher_id = $1 where teacher_id = $2', [
          hidden,
          shown,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await countVideos(shown)).toBe(2);
    expect(await countVideos(hidden)).toBe(1);
  });
});

describe('anon', () => {
  it('sees nothing and cannot insert', async () => {
    const seen = await db.asAnon(async (sql) => {
      const res = await sql.query('select * from public.teacher_videos');
      return res.rows;
    });
    expect(seen).toEqual([]);

    await expect(
      db.asAnon(async (sql) => {
        await sql.query(
          'insert into public.teacher_videos (teacher_id, youtube_id) values ($1, $2)',
          [shown, 'hhhhhhhhhhh'],
        );
      }),
    ).rejects.toThrow();
  });
});
