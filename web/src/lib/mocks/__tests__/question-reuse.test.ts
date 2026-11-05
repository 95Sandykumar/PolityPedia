/**
 * Reusing issue 11's question form for a MOCK TEST question
 * (issue 15-mock-sets-authoring).
 *
 * `questions.test_id` was a plain uuid until 0015 turned it into a real
 * foreign key, and the review form only ever sent a `paperId`. A mock test
 * question is the same row with the other parent, so the one thing that had to
 * change is the XOR: exactly ONE of `paperId` and `testId`.
 *
 * What is pinned here:
 *
 *  * a body with a `testId` and no `paperId` reads as a mock test question.
 *  * a body with BOTH is refused: `questions_one_parent_check` would refuse it
 *    in Postgres, and refusing early means the teacher is told, not the row.
 *  * a body with NEITHER is refused.
 *  * the insert sends `test_id` and a NULL `paper_id`, and still never a
 *    `status` (V9).
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseQuestionsClient } from '@/lib/questions/supabase-questions-client';
import { readQuestionEdit } from '@/lib/questions/types';

const PAPER = '11111111-1111-4111-8111-111111111111';
const TEST = '33333333-3333-4333-8333-333333333333';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const QUESTION = '44444444-4444-4444-8444-444444444444';

const FOUR = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const BODY = {
  id: null,
  testId: TEST,
  number: 1,
  stem: 'Which house is the Council of States?',
  options: FOUR,
  correctIdx: 1,
  teacherExplanation: null,
  lang: 'en',
  checked: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function questionRow(over: Record<string, unknown> = {}) {
  return {
    id: QUESTION,
    teacher_id: TEACHER,
    paper_id: null,
    test_id: TEST,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: FOUR,
    correct_idx: 1,
    teacher_explanation: null,
    topic_id: null,
    lang: 'en',
    image_path: null,
    checked: true,
    status: 'draft',
    ...over,
  };
}

describe('readQuestionEdit with a test id', () => {
  it('reads a mock test question: test id set, paper id null', () => {
    const edit = readQuestionEdit(BODY);
    expect(edit?.testId).toBe(TEST);
    expect(edit?.paperId).toBeNull();
    expect(edit?.checked).toBe(true);
  });

  it('refuses a body with BOTH parents', () => {
    expect(readQuestionEdit({ ...BODY, paperId: PAPER })).toBeNull();
  });

  it('refuses a body with NEITHER parent', () => {
    expect(readQuestionEdit({ ...BODY, testId: null })).toBeNull();
  });

  it('refuses a test id that is not a uuid', () => {
    expect(readQuestionEdit({ ...BODY, testId: 'test-1' })).toBeNull();
  });

  it('still reads a past paper question exactly as it did before', () => {
    const edit = readQuestionEdit({ ...BODY, testId: null, paperId: PAPER });
    expect(edit?.paperId).toBe(PAPER);
    expect(edit?.testId).toBeNull();
  });
});

describe('the questions client with a test id', () => {
  it('inserts test_id, a null paper_id, and still no status (V9)', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow()]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'caller-token',
      userId: TEACHER,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const saved = await client.save({
      id: null,
      paperId: null,
      testId: TEST,
      number: 1,
      stem: 'Which house is the Council of States?',
      options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
      correctIdx: 1,
      teacherExplanation: null,
      lang: 'en',
      checked: true,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.teacher_id).toBe(TEACHER);
    expect(body.test_id).toBe(TEST);
    expect(body.paper_id).toBeNull();
    expect(body).not.toHaveProperty('status');

    expect(saved.testId).toBe(TEST);
    expect(saved.paperId).toBeNull();
  });

  it('refuses an edit with no parent at all, before the request', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow()]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'caller-token',
      userId: TEACHER,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.save({
        id: null,
        paperId: null,
        testId: null,
        number: 1,
        stem: 'Orphan',
        options: ['a', 'b', 'c', 'd'],
        correctIdx: 0,
        teacherExplanation: null,
        lang: 'en',
        checked: false,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the questions of one test in number order', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow()]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'caller-token',
      userId: TEACHER,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const rows = (await client.listForTest?.(TEST)) ?? [];

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/rest/v1/questions');
    expect(url).toContain(`test_id=eq.${TEST}`);
    expect(url).toContain('order=number.asc');

    expect(rows.map((one) => one.id)).toEqual([QUESTION]);
  });

  it('refuses a test id that is not a uuid, before building a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'caller-token',
      userId: TEACHER,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.listForTest?.('test-1')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
