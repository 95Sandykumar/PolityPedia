/**
 * The Saved tab's server read, now that a failure is visible
 * (issue 54c-read-errors-saved-practice-media).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * `fetch` is injected, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { readSavedQuestions, readSavedQuestionsResult } from '../student-page';
import type { AuthSession } from '@/lib/auth/types';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const QUESTION = '33333333-3333-4333-8333-333333333333';

const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

const SAVED_ROW = {
  question_id: QUESTION,
  tag: 'wrong',
  created_at: '2026-01-01T00:00:00Z',
  questions: {
    teacher_id: TEACHER,
    paper_id: null,
    number: 7,
    stem: 'Who presides over the Rajya Sabha?',
  },
};

function always(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

function read(fetchImpl: typeof fetch) {
  return readSavedQuestionsResult(SESSION, { env: ENV, fetchImpl });
}

describe('readSavedQuestionsResult', () => {
  it('a 200 with no rows is OK and empty, so the tab keeps its empty state', async () => {
    const result = await read(always([]));

    expect(result).toEqual({ ok: true, data: [] });
  });

  it('a 200 with rows is OK and carries them', async () => {
    const result = await read(always([SAVED_ROW]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok read');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.questionId).toBe(QUESTION);
  });

  it('a 400 is a FAILED read, never an empty one', async () => {
    const result = await read(always({ message: 'bad request' }, 400));

    expect(result).toEqual({ ok: false });
  });

  it('a 500 is a FAILED read', async () => {
    const result = await read(always({ message: 'boom' }, 500));

    expect(result).toEqual({ ok: false });
  });

  it('a thrown request is a FAILED read', async () => {
    const thrower = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(await read(thrower)).toEqual({ ok: false });
  });

  it('signed out is an OK empty read, not a failure', async () => {
    const fetchImpl = always([]);

    expect(await readSavedQuestionsResult(null, { env: ENV, fetchImpl })).toEqual({
      ok: true,
      data: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names no table, column, key or status anywhere in the answer', async () => {
    const result = await read(
      always({ message: 'column saved_questions.archived_at does not exist' }, 400),
    );

    expect(JSON.stringify(result)).toBe(JSON.stringify({ ok: false }));
  });
});

describe('readSavedQuestions, the plain flavour', () => {
  it('still hands back rows on a read that worked', async () => {
    const items = await readSavedQuestions(SESSION, { env: ENV, fetchImpl: always([SAVED_ROW]) });

    expect(items).toHaveLength(1);
  });

  it('hands back an empty list on a failure, for callers with no error state', async () => {
    const items = await readSavedQuestions(SESSION, {
      env: ENV,
      fetchImpl: always({ message: 'bad request' }, 400),
    });

    expect(items).toEqual([]);
  });
});
