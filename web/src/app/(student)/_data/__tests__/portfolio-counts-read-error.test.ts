/**
 * The four tile counts on a teacher page, now that a failure is visible
 * (issue 54b-read-errors-home-teachers).
 *
 * Definition of done: "the tile counts on the teacher page". A count is the
 * same lie in miniature: the read broke, the client swallowed the 400 into
 * `[]`, and the tile said "0" next to Past papers as if the teacher had
 * uploaded nothing. `null` means "could not read", and the tile then shows NO
 * number, which is the honest answer.
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { readPortfolioCounts } from '../student-ui-data';
import type { AuthSession } from '@/lib/auth/types';
import type { PublicTeacher } from '@/lib/teachers/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const EXAM = 'a4000001-0000-4000-8000-000000000001';

const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

/** `videosVisible: false`, so the three non-video counts are read alone. */
const TEACHER: PublicTeacher = {
  userId: TEACHER_ID,
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: false,
};

const PAPER_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  teacher_id: TEACHER_ID,
  exam_id: EXAM,
  year: 2024,
  month: 6,
  label: 'Shift 1',
  pdf_questions_path: 'papers/q.pdf',
  pdf_solutions_path: null,
  status: 'live',
  archived_at: null,
};

const POST_ROW = {
  id: '66666666-6666-4666-8666-666666666666',
  teacher_id: TEACHER_ID,
  priority: 0,
  heading: 'Class moved to Monday',
  link: null,
  created_at: '2026-11-08T10:00:00.000Z',
};

/** Which table a request is for, so one fake answers all of them. */
function tableOf(url: string): string {
  if (url.includes('/rest/v1/papers')) return 'papers';
  if (url.includes('/rest/v1/mock_sets')) return 'mock_sets';
  if (url.includes('/rest/v1/teacher_posts')) return 'teacher_posts';
  if (url.includes('/rest/v1/teacher_videos')) return 'teacher_videos';
  if (url.includes('/rest/v1/teachers_public')) return 'teachers_public';
  return 'other';
}

/**
 * A fake Supabase. `broken` names the tables that answer 400; everything else
 * answers 200 with the rows given.
 */
function supabase({
  rows = {},
  broken = [],
}: {
  rows?: Record<string, unknown[]>;
  broken?: string[];
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const table = tableOf(String(input));
    if (broken.includes(table)) {
      return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
    }
    return new Response(JSON.stringify(rows[table] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
}

function counts(fetchImpl: typeof fetch) {
  return readPortfolioCounts(SESSION, TEACHER, { env: ENV, fetchImpl });
}

/** The same teacher with videos switched ON, so the videos tile is read too. */
const SHOWS_VIDEOS: PublicTeacher = { ...TEACHER, videosVisible: true };

/**
 * One row of the `teachers_public` VIEW. The videos read looks the teacher up
 * there first, and stops at 0 rows, so the video-count cases need it present.
 */
const TEACHER_ROW = {
  user_id: TEACHER_ID,
  identity_mode: 'alias',
  display_name: 'Polity Guru',
  avatar_path: null,
  bio_en: null,
  bio_hi: null,
  videos_visible: true,
};

function videoCounts(fetchImpl: typeof fetch) {
  return readPortfolioCounts(SESSION, SHOWS_VIDEOS, { env: ENV, fetchImpl });
}

describe('readPortfolioCounts when every read answered 200 with no rows', () => {
  it('shows a real 0, because 0 is true', async () => {
    const result = await counts(supabase({}));

    expect(result.papers).toBe(0);
    expect(result.mocks).toBe(0);
    expect(result.news).toBe(0);
  });

  it('counts the rows it was given', async () => {
    const result = await counts(
      supabase({ rows: { papers: [PAPER_ROW], teacher_posts: [POST_ROW] } }),
    );

    expect(result.papers).toBe(1);
    expect(result.news).toBe(1);
  });
});

describe('readPortfolioCounts when a read FAILED', () => {
  it('leaves the papers count out rather than saying 0', async () => {
    const result = await counts(supabase({ broken: ['papers'] }));

    expect(result.papers).toBeNull();
  });

  it('leaves the notices count out rather than saying 0', async () => {
    const result = await counts(supabase({ broken: ['teacher_posts'] }));

    expect(result.news).toBeNull();
  });

  it('leaves the mock-test count out rather than saying 0', async () => {
    const result = await counts(supabase({ broken: ['mock_sets'] }));

    expect(result.mocks).toBeNull();
  });

  it('drops ONLY the broken count: a good read still shows its number', async () => {
    const result = await counts(
      supabase({ rows: { teacher_posts: [POST_ROW] }, broken: ['papers'] }),
    );

    expect(result.papers).toBeNull();
    expect(result.news).toBe(1);
  });

  it('every count is out when the whole thing is down', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await counts(fetchImpl);

    expect(result.papers).toBeNull();
    expect(result.mocks).toBeNull();
    expect(result.news).toBeNull();
  });
});

/**
 * The videos count was the last one on the old fail-soft shape: it came from
 * `readStudentVideos`, which turns a failure into an empty list, so `.length`
 * made a broken read say "0" (issue 54-visible-read-errors, the close-out).
 */
describe('the videos tile count', () => {
  it('is left out when the videos read FAILED', async () => {
    const result = await videoCounts(
      supabase({ rows: { teachers_public: [TEACHER_ROW] }, broken: ['teacher_videos'] }),
    );

    expect(result.videos).toBeNull();
  });

  it('is left out when the teacher read behind it FAILED', async () => {
    const result = await videoCounts(supabase({ broken: ['teachers_public'] }));

    expect(result.videos).toBeNull();
  });

  it('is a real 0 when the read worked and there is nothing to show', async () => {
    const result = await videoCounts(supabase({ rows: { teachers_public: [TEACHER_ROW] } }));

    expect(result.videos).toBe(0);
  });

  it('is left out, not 0, when the teacher keeps videos switched off', async () => {
    const result = await counts(supabase({}));

    expect(result.videos).toBeNull();
  });
});
