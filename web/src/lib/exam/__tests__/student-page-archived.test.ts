/**
 * The exam read on an archived test (issue 45-keep-money-and-scores).
 *
 * `attempts_no_new_on_archived` (0041) refuses the INSERT that starts a
 * sitting. This file pins the message in front of it: when no sitting could be
 * opened or resumed and the test, or its set, is archived, `readExamLoad`
 * throws `TestArchived` (the route turns it into a 409 with a clear
 * sentence). A test that is not archived keeps the old behaviour: an empty
 * "not ready" payload, never a throw.
 *
 * Every client is a fake: no real network call and no key (web/CLAUDE.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import type { MockSet, MockTest } from '@/lib/mocks/types';

const SESSION: AuthSession = {
  accessToken: 'student-token',
  refreshToken: 'refresh',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'student',
  teacherStatus: undefined,
};

const TEST_ID = '33333333-3333-4333-8333-333333333333';
const SET_ID = '11111111-1111-4111-8111-111111111111';

const state: { test: MockTest | null; set: MockSet | null; attempt: unknown } = {
  test: null,
  set: null,
  attempt: null,
};

vi.mock('@/lib/mocks/supabase-mocks-client', () => ({
  createSupabaseMocksClient: () => ({
    readTest: async () => state.test,
    readOne: async () => state.set,
  }),
}));
vi.mock('@/lib/questions/supabase-questions-client', () => ({
  createSupabaseQuestionsClient: () => ({ listForTest: async () => [] }),
}));
vi.mock('@/lib/exam/supabase-exam-client', () => ({
  createSupabaseExamClient: () => ({
    openOrStartExam: async () => {
      if (!state.attempt) throw new Error('row-level security');
      return state.attempt;
    },
  }),
}));
vi.mock('@/lib/attempts/supabase-attempts-client', () => ({
  createSupabaseAttemptsClient: () => ({ listAnswers: async () => new Map() }),
}));
vi.mock('@/lib/teacher-exams/teacher-page', () => ({
  readExamCatalogue: async () => [],
}));

import { readExamLoad } from '../student-page';

function test(over: Partial<MockTest> = {}): MockTest {
  return {
    id: TEST_ID,
    setId: SET_ID,
    title: 'Test 1',
    position: 1,
    durationMin: 60,
    isFreeSample: false,
    ...over,
  };
}

function set(over: Partial<MockSet> = {}): MockSet {
  return {
    id: SET_ID,
    teacherId: '44444444-4444-4444-8444-444444444444',
    examId: 'a4000001-0000-4000-8000-000000000001',
    title: 'Sold set',
    priceInr: 299,
    status: 'live',
    ...over,
  };
}

beforeEach(() => {
  state.test = test();
  state.set = set();
  state.attempt = null;
});

describe('readExamLoad on an archived test', () => {
  it('throws TestArchived when the test is archived and no sitting opens', async () => {
    state.test = test({ archivedAt: '2026-11-01T00:00:00Z' });
    await expect(
      readExamLoad(SESSION, TEST_ID, { topicId: null, langMode: 'en' }),
    ).rejects.toMatchObject({ name: 'TestArchived' });
  });

  it('does NOT throw when only the set is archived: a buyer keeps sitting its tests', async () => {
    state.set = set({ archivedAt: '2026-11-01T00:00:00Z' });
    state.attempt = {
      id: 'a2',
      testId: TEST_ID,
      submittedAt: null,
      deadlineAt: '2026-11-08T12:00:00Z',
      score: null,
    };
    const load = await readExamLoad(SESSION, TEST_ID, { topicId: null, langMode: 'en' });
    expect(load.attempt).not.toBeNull();
  });

  it('with only the set archived and no sitting, gives the old "not ready" payload, not TestArchived', async () => {
    state.set = set({ archivedAt: '2026-11-01T00:00:00Z' });
    const load = await readExamLoad(SESSION, TEST_ID, { topicId: null, langMode: 'en' });
    expect(load.attempt).toBeNull();
  });

  it('keeps the old "not ready" payload for a live test with no sitting', async () => {
    const load = await readExamLoad(SESSION, TEST_ID, { topicId: null, langMode: 'en' });
    expect(load.attempt).toBeNull();
    expect(load.questions).toEqual([]);
  });

  it('still opens an existing sitting on an archived test (old results stay)', async () => {
    state.test = test({ archivedAt: '2026-11-01T00:00:00Z' });
    state.attempt = {
      id: 'a1',
      testId: TEST_ID,
      submittedAt: '2026-10-30T00:00:00Z',
      deadlineAt: null,
      score: 7,
    };
    const load = await readExamLoad(SESSION, TEST_ID, { topicId: null, langMode: 'en' });
    expect(load.attempt).not.toBeNull();
    expect(load.revealed).toBe(true);
  });
});
