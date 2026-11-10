/**
 * The two teacher-list reads, now that a failure is visible
 * (issue 54b-read-errors-home-teachers).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * Home reads the teachers the student FOLLOWS, the Teachers tab reads every
 * APPROVED teacher. Both used to end in `.catch(() => [])` on top of a client
 * that already turns a 400 into `[]`, so a broken read arrived at the screen
 * looking exactly like a student who follows nobody.
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  readApprovedTeachersResult,
  readFollowedTeachersResult,
  readPortfolioResult,
  readTeacherCardsResult,
} from '../student-page';
import type { AuthSession } from '@/lib/auth/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '44444444-4444-4444-8444-444444444444';

const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

const TEACHER_ROW = {
  user_id: TEACHER,
  identity_mode: 'alias',
  display_name: 'Polity Guru',
  avatar_path: null,
  bio_en: null,
  bio_hi: null,
  videos_visible: true,
};

/** Answers every request with the same body and status. */
function always(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/**
 * Answers the requests in order, by what the URL asks for: the follows table
 * first, then the public-teachers view.
 */
function inOrder(...steps: { body: unknown; status?: number }[]) {
  let at = 0;
  return (async () => {
    const step = steps[Math.min(at, steps.length - 1)];
    at += 1;
    return new Response(JSON.stringify(step?.body ?? []), { status: step?.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe('readFollowedTeachersResult (Home)', () => {
  it('a 200 with no follows is OK and empty, so Home keeps its empty state', async () => {
    const result = await readFollowedTeachersResult(SESSION, { env: ENV, fetchImpl: always([]) });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 400 on the follows read is a FAILED read, never an empty one', async () => {
    const result = await readFollowedTeachersResult(SESSION, {
      env: ENV,
      fetchImpl: always({ message: 'bad request' }, 400),
    });

    expect(result.ok).toBe(false);
  });

  it('a 400 on the SECOND read (the teachers view) is a failure too', async () => {
    const result = await readFollowedTeachersResult(SESSION, {
      env: ENV,
      fetchImpl: inOrder(
        { body: [{ teacher_id: TEACHER }] },
        { body: { message: 'bad request' }, status: 400 },
      ),
    });

    expect(result.ok).toBe(false);
  });

  it('a request that throws is a FAILED read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await readFollowedTeachersResult(SESSION, { env: ENV, fetchImpl });

    expect(result.ok).toBe(false);
  });

  it('returns the followed teachers when both reads answered 200', async () => {
    const result = await readFollowedTeachersResult(SESSION, {
      env: ENV,
      fetchImpl: inOrder({ body: [{ teacher_id: TEACHER }] }, { body: [TEACHER_ROW] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.displayName).toBe('Polity Guru');
    }
  });

  it('asks for the same rows as before: the follow order, newest first', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response('[]', { status: 200 });
    };
    await readFollowedTeachersResult(SESSION, { env: ENV, fetchImpl });

    expect(seen[0]).toContain('select=teacher_id');
    expect(seen[0]).toContain('order=created_at.desc');
    expect(seen[0]).not.toContain('select=*');
  });
});

describe('readApprovedTeachersResult (Teachers tab)', () => {
  it('a 200 with no rows is OK and empty, so the tab keeps its empty state', async () => {
    const result = await readApprovedTeachersResult(SESSION, { env: ENV, fetchImpl: always([]) });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 400 is a FAILED read, never an empty one', async () => {
    const result = await readApprovedTeachersResult(SESSION, {
      env: ENV,
      fetchImpl: always({ message: 'bad request' }, 400),
    });

    expect(result.ok).toBe(false);
  });

  it('a request that throws is a FAILED read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await readApprovedTeachersResult(SESSION, { env: ENV, fetchImpl });

    expect(result.ok).toBe(false);
  });

  it('returns the rows when the read answered 200', async () => {
    const result = await readApprovedTeachersResult(SESSION, {
      env: ENV,
      fetchImpl: always([TEACHER_ROW]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]?.userId).toBe(TEACHER);
  });

  it('still reads the public VIEW, never the teachers table', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response('[]', { status: 200 });
    };
    await readApprovedTeachersResult(SESSION, { env: ENV, fetchImpl });

    expect(seen[0]).toContain('/rest/v1/teachers_public');
    expect(seen[0]).not.toContain('select=*');
  });
});

/**
 * Issue 67-teachers-filter-and-free-badge: the Teachers tab reader.
 *
 * The badge and the exam filter are both columns of the `teacher_cards` view
 * (0050), so the whole list is ONE request (B8). These tests watch the URL,
 * because that is where the promise lives: one call, the right view, the
 * overlap filter, and no `select=*`.
 */
const CARD_ROW = { ...TEACHER_ROW, has_free_sample: true };
const EXAM_A = '22222222-2222-4222-8222-222222222222';
const EXAM_B = '33333333-3333-4333-8333-333333333333';

/** Every URL the reader asked for, in order. */
function watchUrls(seen: string[], body: unknown = [], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe('readTeacherCardsResult (Teachers tab with the exam filter)', () => {
  it('reads the card view in ONE request, never one per teacher', async () => {
    const seen: string[] = [];
    await readTeacherCardsResult(SESSION, { examIds: [EXAM_A, EXAM_B] }, {
      env: ENV,
      fetchImpl: watchUrls(seen, [CARD_ROW]),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/rest/v1/teacher_cards');
    expect(seen[0]).not.toContain('select=*');
  });

  it('sends the chosen exams as an overlap filter', async () => {
    const seen: string[] = [];
    await readTeacherCardsResult(SESSION, { examIds: [EXAM_A, EXAM_B] }, {
      env: ENV,
      fetchImpl: watchUrls(seen),
    });

    expect(seen[0]).toContain(`exam_ids=ov.{${EXAM_A},${EXAM_B}}`);
  });

  it('sends no exam filter at all for "Show all"', async () => {
    const seen: string[] = [];
    await readTeacherCardsResult(SESSION, {}, { env: ENV, fetchImpl: watchUrls(seen) });

    expect(seen[0]).not.toContain('exam_ids');
  });

  it('carries the badge through to the screen', async () => {
    const result = await readTeacherCardsResult(SESSION, {}, {
      env: ENV,
      fetchImpl: always([CARD_ROW]),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]?.hasFreeSample).toBe(true);
  });

  it('a 400 is a FAILED read, never an empty list', async () => {
    const result = await readTeacherCardsResult(SESSION, {}, {
      env: ENV,
      fetchImpl: always({ message: 'bad request' }, 400),
    });

    expect(result.ok).toBe(false);
  });

  it('is an OK empty read when nobody is signed in', async () => {
    const result = await readTeacherCardsResult(null, {}, { env: ENV, fetchImpl: always([]) });

    expect(result).toEqual({ ok: true, data: [] });
  });
});

/**
 * `/t/<id>` itself, the screen that holds all the lists
 * (issue 54-visible-read-errors, the close-out pass).
 *
 * The teacher read used to end in `.catch(() => null)`, and the page draws
 * `teacher: null` as "Teacher not found". So a dropped request told the
 * student their own teacher does not exist, which is worse than any empty
 * list: there is nothing left on the screen to retry.
 */
describe('readPortfolioResult (/t/<id>)', () => {
  it('a 200 with no such teacher is an OK read, so the page keeps its own line', async () => {
    const result = await readPortfolioResult(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: always([]),
    });

    expect(result).toEqual({ ok: true, data: { teacher: null, following: false, nextExam: null } });
  });

  it('a 400 on the teacher read is a FAILED read, never a missing teacher', async () => {
    const result = await readPortfolioResult(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: always({ message: 'column teachers.archived_at does not exist' }, 400),
    });

    expect(result.ok).toBe(false);
  });

  it('a 400 on the FOLLOW read fails too: no follow state, no honest button', async () => {
    const result = await readPortfolioResult(SESSION, TEACHER, {
      env: ENV,
      fetchImpl: inOrder({ body: [CARD_ROW] }, { body: { message: 'bad request' }, status: 400 }),
    });

    expect(result.ok).toBe(false);
  });

  it('a thrown request is a FAILED read', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await readPortfolioResult(SESSION, TEACHER, { env: ENV, fetchImpl });

    expect(result.ok).toBe(false);
  });

  it('signed out is an OK empty read, not a failure', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await readPortfolioResult(null, TEACHER, { env: ENV, fetchImpl });

    expect(result).toEqual({ ok: true, data: { teacher: null, following: false, nextExam: null } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
