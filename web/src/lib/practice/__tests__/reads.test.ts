/**
 * The three reads practice mode adds (issue 17-practice-mode).
 *
 * `fetch` and the env bag are injected, so there is no real network call and
 * no real key in this test (web/CLAUDE.md).
 *
 * What it has to prove:
 *
 *  * F-E4, THE TOPIC FILTER IS IN THE QUERY. "One topic" loads only that
 *    topic's questions, so the filter is `topic_id=eq.<id>` on the REST read
 *    and not a slice done in the browser after the whole paper arrived.
 *  * "Full paper" sends NO topic filter, which is what the default means.
 *  * A sitting of a mock test resumes only a sitting of the SAME topic, so
 *    switching from Full paper to one topic is a new sitting and not a
 *    half-answered one with the wrong questions in it.
 *  * Every call carries the caller's own token, so RLS is the gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseAttemptsClient } from '@/lib/attempts/supabase-attempts-client';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import { createSupabaseQuestionsClient } from '@/lib/questions/supabase-questions-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const TEST = '44444444-4444-4444-8444-444444444444';
const TOPIC = '55555555-5555-4555-8555-555555555555';
const ATTEMPT = '66666666-6666-4666-8666-666666666666';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function questionRow(over: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    teacher_id: TEACHER,
    paper_id: null,
    test_id: TEST,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
    correct_idx: 1,
    teacher_explanation: null,
    topic_id: TOPIC,
    lang: 'en',
    image_path: null,
    checked: true,
    status: 'live',
    ...over,
  };
}

function testRow(over: Record<string, unknown> = {}) {
  return {
    id: TEST,
    set_id: SET,
    title: 'Test 2',
    position: 2,
    duration_min: 120,
    is_free_sample: false,
    ...over,
  };
}

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    user_id: STUDENT,
    paper_id: null,
    test_id: TEST,
    mode: 'practice',
    topic_id: null,
    deadline_at: null,
    submitted_at: null,
    score: null,
    ...over,
  };
}

/** Every URL the client asked for, in order. */
function urls(fetchImpl: { mock: { calls: unknown[] } }): string[] {
  return (fetchImpl.mock.calls as unknown[][]).map((call) => String(call[0]));
}

/** The `RequestInit` of one call, so a test can read a header or a body. */
function init(
  fetchImpl: { mock: { calls: unknown[] } },
  index: number,
): { method?: string; headers?: Record<string, string>; body?: string } {
  const call = (fetchImpl.mock.calls as unknown[][])[index] ?? [];
  return (call[1] ?? {}) as {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
}

describe('listForTest with a topic', () => {
  it('asks Postgres for that topic only', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow()]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const found = await client.listForTest?.(TEST, TOPIC);

    expect(found).toHaveLength(1);
    const url = urls(fetchImpl)[0];
    expect(url).toContain('test_id=eq.' + TEST);
    expect(url).toContain('topic_id=eq.' + TOPIC);
  });

  it('sends no topic filter for the full paper', async () => {
    const fetchImpl = vi.fn(async () => json([questionRow({ topic_id: null })]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.listForTest?.(TEST, null);

    // `topic_id` is one of the columns asked for, so only the FILTER must be
    // missing.
    expect(urls(fetchImpl)[0]).not.toContain('topic_id=');
  });

  it('refuses a topic that is not a uuid instead of putting it in a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = createSupabaseQuestionsClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.listForTest?.(TEST, '../../secret')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('readTest', () => {
  it('reads one mock test, with the token of whoever is asking', async () => {
    const fetchImpl = vi.fn(async () => json([testRow()]));
    const client = createSupabaseMocksClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const found = await client.readTest?.(TEST);

    expect(found).toEqual({
      id: TEST,
      setId: SET,
      title: 'Test 2',
      position: 2,
      durationMin: 120,
      isFreeSample: false,
    });
    expect(urls(fetchImpl)[0]).toContain('id=eq.' + TEST);
    expect(init(fetchImpl, 0).headers?.authorization).toBe('Bearer student-token');
  });

  it('is null when RLS hides the test, and never a half-filled row', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = createSupabaseMocksClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.readTest?.(TEST)).toBeNull();
  });

  it('never puts a bad id in a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = createSupabaseMocksClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.readTest?.('not-a-uuid')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('openOrStartForTest', () => {
  function attempts(fetchImpl: typeof fetch) {
    return createSupabaseAttemptsClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl,
    });
  }

  it('resumes the open practice sitting of the full paper', async () => {
    const fetchImpl = vi.fn(async () => json([attemptRow()]));
    const client = attempts(fetchImpl as unknown as typeof fetch);

    const found = await client.openOrStartForTest?.({ testId: TEST, mode: 'practice' });

    expect(found?.id).toBe(ATTEMPT);
    expect(found?.testId).toBe(TEST);
    // One request: it resumed, so nothing was inserted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = urls(fetchImpl)[0];
    expect(url).toContain('test_id=eq.' + TEST);
    expect(url).toContain('mode=eq.practice');
    expect(url).toContain('submitted_at=is.null');
    // Full paper: the open sitting must have NO topic, or it holds the wrong
    // questions.
    expect(url).toContain('topic_id=is.null');
  });

  it('resumes only a sitting of the same topic', async () => {
    const fetchImpl = vi.fn(async () => json([attemptRow({ topic_id: TOPIC })]));
    const client = attempts(fetchImpl as unknown as typeof fetch);

    await client.openOrStartForTest?.({ testId: TEST, mode: 'practice', topicId: TOPIC });

    const url = urls(fetchImpl)[0];
    expect(url).toContain('topic_id=eq.' + TOPIC);
    expect(url).not.toContain('topic_id=is.null');
  });

  it('starts a new sitting when none is open, with the topic on the row', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([attemptRow({ topic_id: TOPIC })]));
    const client = attempts(fetchImpl as unknown as typeof fetch);

    const started = await client.openOrStartForTest?.({
      testId: TEST,
      mode: 'practice',
      topicId: TOPIC,
    });

    expect(started?.topicId).toBe(TOPIC);
    const insert = init(fetchImpl, 1);
    expect(insert.method).toBe('POST');
    const body = JSON.parse(String(insert.body));
    expect(body).toEqual({
      user_id: STUDENT,
      // XOR: a mock sitting has a test and no paper.
      paper_id: null,
      test_id: TEST,
      mode: 'practice',
      topic_id: TOPIC,
    });
  });

  it('never puts a bad test id in a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = attempts(fetchImpl as unknown as typeof fetch);

    await expect(
      client.openOrStartForTest?.({ testId: 'not-a-uuid', mode: 'practice' }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
