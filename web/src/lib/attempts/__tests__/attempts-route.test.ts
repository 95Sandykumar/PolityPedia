/**
 * The attempts route handler and the browser client
 * (issue 13-question-player).
 *
 * The player holds NO Supabase key: it posts to our own route, which reads the
 * student's access token out of the httpOnly session cookie and lets Postgres
 * RLS (`attempts_*`, `attempt_answers_*`) decide. So the two sides of that
 * wire are tested together here, with a fake client and a fake `fetch`: no
 * real network call and no real key (web/CLAUDE.md).
 *
 * Order of checks: session, config, then the body. A body is never looked at
 * before we know who is asking.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBrowserAttemptsClient } from '../browser-attempts-client';
import { handleSaveAnswer, handleSubmitAttempt } from '../attempts-route';
import {
  ATTEMPT_ANSWERS_PATH,
  ATTEMPT_SUBMIT_PATH,
  type AnswerUpsert,
  type Attempt,
  type AttemptAnswer,
  type AttemptsClient,
  type AttemptSubmit,
} from '../types';
import type { AuthSession } from '@/lib/auth/types';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const QUESTION = '22222222-2222-4222-8222-222222222221';
const STUDENT = '33333333-3333-4333-8333-333333333333';

const SESSION: AuthSession = {
  userId: STUDENT,
  accessToken: 'student-token',
  refreshToken: 'student-refresh',
  role: 'student',
};

function answer(extra: Partial<AnswerUpsert> = {}): AnswerUpsert {
  return {
    attemptId: ATTEMPT,
    questionId: QUESTION,
    chosenIdx: 1,
    isCorrect: true,
    marked: false,
    ...extra,
  };
}

function fakeClient(overrides: Partial<AttemptsClient> = {}) {
  const saved: AnswerUpsert[] = [];
  const submitted: AttemptSubmit[] = [];
  const client: AttemptsClient = {
    isConfigured: () => true,
    openOrStartForPaper: async () => ({}) as Attempt,
    listAnswers: async () => new Map<string, AttemptAnswer>(),
    saveAnswer: async (one) => {
      saved.push(one);
    },
    submit: async (one) => {
      submitted.push(one);
    },
    ...overrides,
  };
  return { client, saved, submitted };
}

describe('handleSaveAnswer', () => {
  it('stores one answer for a signed-in student', async () => {
    const { client, saved } = fakeClient();

    const reply = await handleSaveAnswer({ body: answer(), session: SESSION, client });

    expect(reply.status).toBe(200);
    expect(saved).toEqual([answer()]);
  });

  it('turns a stranger away before it reads the body', async () => {
    const { client, saved } = fakeClient();

    const reply = await handleSaveAnswer({
      body: answer(),
      session: null,
      client,
    });

    expect(reply.status).toBe(401);
    expect(saved).toHaveLength(0);
  });

  it('says 503 when Supabase is not configured', async () => {
    const { client } = fakeClient({ isConfigured: () => false });
    const reply = await handleSaveAnswer({ body: answer(), session: SESSION, client });
    expect(reply.status).toBe(503);
  });

  it('refuses a body it cannot read', async () => {
    const { client, saved } = fakeClient();

    for (const bad of [null, 'answer', {}, answer({ chosenIdx: 9 })]) {
      const reply = await handleSaveAnswer({ body: bad, session: SESSION, client });
      expect(reply.status).toBe(400);
    }
    expect(saved).toHaveLength(0);
  });

  it('never lets a Postgres message reach the browser', async () => {
    const { client } = fakeClient({
      saveAnswer: async () => {
        throw new Error('new row violates row-level security policy "attempts_insert_own"');
      },
    });

    const reply = await handleSaveAnswer({ body: answer(), session: SESSION, client });

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('attempts_insert_own');
  });

  it('a teacher may sit a paper too', async () => {
    // An attempt hangs on `auth.users`, not on `teachers`, so there is no role
    // check here: a teacher trying their own paper is a normal thing to do.
    const { client, saved } = fakeClient();
    const reply = await handleSaveAnswer({
      body: answer(),
      session: { ...SESSION, role: 'teacher', teacherStatus: 'approved' },
      client,
    });
    expect(reply.status).toBe(200);
    expect(saved).toHaveLength(1);
  });
});

describe('handleSubmitAttempt', () => {
  it('closes the sitting with its score', async () => {
    const { client, submitted } = fakeClient();

    const reply = await handleSubmitAttempt({
      body: { attemptId: ATTEMPT, score: 7 },
      session: SESSION,
      client,
    });

    expect(reply.status).toBe(200);
    expect(submitted).toEqual([{ attemptId: ATTEMPT, score: 7 }]);
  });

  it('refuses a score that is not a whole number', async () => {
    const { client } = fakeClient();
    const reply = await handleSubmitAttempt({
      body: { attemptId: ATTEMPT, score: 7.5 },
      session: SESSION,
      client,
    });
    expect(reply.status).toBe(400);
  });

  it('turns a stranger away', async () => {
    const { client } = fakeClient();
    const reply = await handleSubmitAttempt({
      body: { attemptId: ATTEMPT, score: 7 },
      session: null,
      client,
    });
    expect(reply.status).toBe(401);
  });
});

describe('createBrowserAttemptsClient', () => {
  it('posts the answer to our own route, never to Supabase', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = createBrowserAttemptsClient(fetchImpl as unknown as typeof fetch);

    await client.saveAnswer(answer());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ATTEMPT_ANSWERS_PATH);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(answer());
    // No key and no token anywhere in the request the browser makes.
    expect(JSON.stringify(init.headers)).not.toMatch(/apikey|authorization/i);
  });

  it('throws on a failed save, so the queue keeps the answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const client = createBrowserAttemptsClient(fetchImpl as unknown as typeof fetch);

    // A resolved promise here would silently lose the answer.
    await expect(client.saveAnswer(answer())).rejects.toThrow(/503/);
  });

  it('posts the submit to its own route', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = createBrowserAttemptsClient(fetchImpl as unknown as typeof fetch);

    await client.submit({ attemptId: ATTEMPT, score: 7 });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(ATTEMPT_SUBMIT_PATH);
  });
});
