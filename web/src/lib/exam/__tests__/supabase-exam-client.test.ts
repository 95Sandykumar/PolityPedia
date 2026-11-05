/**
 * The server-side `ExamClient` over Supabase REST (issue 18-exam-mode).
 *
 * `fetch` and the env bag are injected, so there is no real network call and
 * no real key in this test (web/CLAUDE.md).
 *
 * What it has to prove:
 *
 *  * STARTING A SITTING SETS THE DEADLINE. `deadline_at = now + duration` is
 *    computed on the SERVER and stored, so the clock is one value both sides
 *    agree on and not something the phone made up.
 *  * A SITTING IS RESUMED, NOT RESTARTED. A student who closes the tab walks
 *    back into the same clock, never into another full hour.
 *  * THE WRITE CARRIES NO VERDICT. `is_correct` goes out as an explicit null,
 *    because the phone was never given `correct_idx` (F-E5).
 *  * THE SCORE COMES FROM `score_attempt()`, one RPC, never from a sum done
 *    here.
 *  * EVERY CALL CARRIES THE CALLER'S OWN TOKEN, so RLS is the gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseExamClient } from '../supabase-exam-client';

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEST = '33333333-3333-4333-8333-333333333333';
const TOPIC = '44444444-4444-4444-8444-444444444444';
const ATTEMPT = '55555555-5555-4555-8555-555555555555';
const QUESTION = '66666666-6666-4666-8666-666666666666';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    user_id: STUDENT,
    paper_id: null,
    test_id: TEST,
    mode: 'exam',
    topic_id: null,
    deadline_at: '2026-11-05T11:30:00.000Z',
    submitted_at: null,
    score: null,
    ...over,
  };
}

function client(fetchImpl: typeof fetch) {
  return createSupabaseExamClient({
    accessToken: 'student-token',
    userId: STUDENT,
    env: ENV,
    fetchImpl,
  });
}

/** The url and the parsed body of call number `index`. */
function call(fetchImpl: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return {
    url,
    init,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

describe('openOrStartExam', () => {
  it('resumes the open timed sitting instead of starting another clock', async () => {
    const fetchImpl = vi.fn(async () => json([attemptRow()]));

    const attempt = await client(fetchImpl as unknown as typeof fetch).openOrStartExam({
      testId: TEST,
      topicId: null,
      durationMin: 90,
    });

    expect(attempt.id).toBe(ATTEMPT);
    expect(attempt.deadlineAt).toBe('2026-11-05T11:30:00.000Z');
    // One call: the resume read. No insert at all.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(call(fetchImpl, 0).init.method).toBe('GET');
  });

  it('asks only for an EXAM sitting that is still open, of the same topic', async () => {
    const fetchImpl = vi.fn(async () => json([attemptRow({ topic_id: TOPIC })]));

    await client(fetchImpl as unknown as typeof fetch).openOrStartExam({
      testId: TEST,
      topicId: TOPIC,
      durationMin: 90,
    });

    const { url } = call(fetchImpl, 0);
    expect(url).toContain(`test_id=eq.${TEST}`);
    expect(url).toContain('mode=eq.exam');
    expect(url).toContain(`topic_id=eq.${TOPIC}`);
    expect(url).toContain('submitted_at=is.null');
  });

  it('starts one with deadline_at = now + duration when none is open', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([attemptRow()]));
    const now = Date.parse('2026-11-05T10:00:00.000Z');

    await createSupabaseExamClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    }).openOrStartExam({ testId: TEST, topicId: null, durationMin: 90 });

    const insert = call(fetchImpl, 1);
    expect(insert.init.method).toBe('POST');
    expect(insert.body).toEqual({
      user_id: STUDENT,
      paper_id: null,
      test_id: TEST,
      mode: 'exam',
      topic_id: null,
      deadline_at: '2026-11-05T11:30:00.000Z',
    });
  });

  it('falls back to the default duration rather than drawing a wrong clock', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([attemptRow()]));
    const now = Date.parse('2026-11-05T10:00:00.000Z');

    await createSupabaseExamClient({
      accessToken: 'student-token',
      userId: STUDENT,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    }).openOrStartExam({ testId: TEST, topicId: null, durationMin: 0 });

    // One hour, which is `mock_tests.duration_min`'s own default.
    expect(call(fetchImpl, 1).body?.deadline_at).toBe('2026-11-05T11:00:00.000Z');
  });

  it('carries the caller s own token, so RLS decides', async () => {
    const fetchImpl = vi.fn(async () => json([attemptRow()]));

    await client(fetchImpl as unknown as typeof fetch).openOrStartExam({
      testId: TEST,
      topicId: null,
      durationMin: 90,
    });

    const { headers } = call(fetchImpl, 0);
    expect(headers.authorization).toBe('Bearer student-token');
    expect(headers.apikey).toBe('anon-key');
  });

  it('refuses a test id that is not a uuid before it builds a URL', async () => {
    const fetchImpl = vi.fn(async () => json([]));

    await expect(
      client(fetchImpl as unknown as typeof fetch).openOrStartExam({
        testId: '../../x',
        topicId: null,
        durationMin: 90,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the insert is refused, so the page says it is not ready', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ message: 'denied' }, 403));

    await expect(
      client(fetchImpl as unknown as typeof fetch).openOrStartExam({
        testId: TEST,
        topicId: null,
        durationMin: 90,
      }),
    ).rejects.toThrow(/403/);
  });
});

describe('saveExamAnswer', () => {
  it('sends an explicit null verdict, because the phone has no answer key', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));

    await client(fetchImpl as unknown as typeof fetch).saveExamAnswer({
      attemptId: ATTEMPT,
      questionId: QUESTION,
      chosenIdx: 2,
      marked: false,
    });

    const { body } = call(fetchImpl, 0);
    expect(body?.chosen_idx).toBe(2);
    expect(body?.is_correct).toBeNull();
    expect(body?.marked).toBe(false);
  });

  it('is an upsert keyed (attempt_id, question_id), so a retry is one row (A1)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));

    await client(fetchImpl as unknown as typeof fetch).saveExamAnswer({
      attemptId: ATTEMPT,
      questionId: QUESTION,
      chosenIdx: 0,
      marked: true,
    });

    const { url, headers } = call(fetchImpl, 0);
    expect(url).toContain('on_conflict=attempt_id,question_id');
    expect(headers.prefer).toContain('resolution=merge-duplicates');
  });

  it('throws on a refusal, which is how an answer after the deadline reads', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'denied' }, 403));

    await expect(
      client(fetchImpl as unknown as typeof fetch).saveExamAnswer({
        attemptId: ATTEMPT,
        questionId: QUESTION,
        chosenIdx: 1,
        marked: false,
      }),
    ).rejects.toThrow(/403/);
  });
});

describe('scoreAttempt', () => {
  it('calls score_attempt() and hands back the number it returns', async () => {
    const fetchImpl = vi.fn(async () => json(10));

    const score = await client(fetchImpl as unknown as typeof fetch).scoreAttempt(ATTEMPT);

    expect(score).toBe(10);
    const { url, init, body } = call(fetchImpl, 0);
    expect(url).toContain('/rest/v1/rpc/score_attempt');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ attempt_id: ATTEMPT });
  });

  it('keeps a score of zero, which is a real sitting and not a missing one', async () => {
    const fetchImpl = vi.fn(async () => json(0));

    expect(await client(fetchImpl as unknown as typeof fetch).scoreAttempt(ATTEMPT)).toBe(0);
  });

  it('reads a negative score, because negative marking is real', async () => {
    const fetchImpl = vi.fn(async () => json(-3));

    expect(await client(fetchImpl as unknown as typeof fetch).scoreAttempt(ATTEMPT)).toBe(-3);
  });

  it('reads a bigint sent as text, the way PostgREST does', async () => {
    const fetchImpl = vi.fn(async () => json('10'));

    expect(await client(fetchImpl as unknown as typeof fetch).scoreAttempt(ATTEMPT)).toBe(10);
  });

  it('throws when the function refuses, never pretending the sitting closed', async () => {
    const fetchImpl = vi.fn(async () => json({ code: '42501' }, 403));

    await expect(
      client(fetchImpl as unknown as typeof fetch).scoreAttempt(ATTEMPT),
    ).rejects.toThrow(/403/);
  });

  it('refuses an attempt id that is not a uuid', async () => {
    const fetchImpl = vi.fn(async () => json(0));

    await expect(
      client(fetchImpl as unknown as typeof fetch).scoreAttempt('nope'),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('isConfigured', () => {
  it('is false with no env, so a page can say so instead of crashing', () => {
    const made = createSupabaseExamClient({
      accessToken: '',
      userId: STUDENT,
      env: {},
      fetchImpl: (async () => json({})) as unknown as typeof fetch,
    });

    expect(made.isConfigured()).toBe(false);
  });
});
