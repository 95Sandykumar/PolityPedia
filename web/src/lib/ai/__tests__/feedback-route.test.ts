/**
 * The thumbs up / down route (issue 23-revision-screen).
 *
 * DESIGN.md section 8: "Thumbs up/down under it (feedback goes to the
 * teacher)." So a vote is a WRITE with the student's own identity on it, and
 * the same four refusals the revision route has:
 *
 *   rate            -- 10 a minute, before any database call.
 *   sign_in         -- no cookie, no vote.
 *   bad_request     -- not a uuid, not en/hi, not up/down.
 *   not_configured  -- no Supabase keys.
 *
 * A vote is IDEMPOTENT by its primary key `(user_id, question_id, lang)`, so
 * a student who taps twice has one opinion, not two rows. That is proved in
 * `test/ai-feedback.test.ts`, in Postgres.
 *
 * The client is a fake, so this file makes no network call and holds no key.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleFeedback } from '../feedback-route';
import type { AuthSession } from '@/lib/auth/types';
import type { FeedbackClient, FeedbackRequest } from '../feedback';

const QUESTION = '22222222-2222-4222-8222-222222222221';

const SESSION: AuthSession = {
  userId: '33333333-3333-4333-8333-333333333333',
  accessToken: 'test-token',
  refreshToken: 'test-refresh',
  role: 'student',
};

/** A limiter that always says yes, so only the test about rate says no. */
const open = { take: () => true };
const closed = { take: () => false };

function fakeClient(overrides: Partial<FeedbackClient> = {}) {
  const saved: FeedbackRequest[] = [];
  const client: FeedbackClient = {
    isConfigured: () => true,
    save: async (request) => {
      saved.push(request);
    },
    ...overrides,
  };
  return { client, saved };
}

describe('handleFeedback', () => {
  it('saves a thumbs up and answers 204', async () => {
    const { client, saved } = fakeClient();

    const reply = await handleFeedback({
      body: { question_id: QUESTION, lang: 'en', vote: 'up' },
      session: SESSION,
      client,
      limiter: open,
    });

    expect(reply.status).toBe(204);
    expect(saved).toEqual([{ questionId: QUESTION, lang: 'en', vote: 'up' }]);
  });

  it('refuses a flood before it touches the database', async () => {
    const save = vi.fn();
    const { client } = fakeClient({ save });

    const reply = await handleFeedback({
      body: { question_id: QUESTION, lang: 'hi', vote: 'down' },
      session: SESSION,
      client,
      limiter: closed,
    });

    expect(reply.status).toBe(429);
    expect(reply.body).toEqual({ error: 'rate' });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a signed-out vote', async () => {
    const { client, saved } = fakeClient();

    const reply = await handleFeedback({
      body: { question_id: QUESTION, lang: 'en', vote: 'up' },
      session: null,
      client,
      limiter: open,
    });

    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: 'sign_in' });
    expect(saved).toHaveLength(0);
  });

  it('refuses a vote that is not up or down, and a bad question id', async () => {
    const { client, saved } = fakeClient();

    for (const body of [
      { question_id: QUESTION, lang: 'en', vote: 'maybe' },
      { question_id: 'not-a-uuid', lang: 'en', vote: 'up' },
      { question_id: QUESTION, lang: 'both', vote: 'up' },
      null,
    ]) {
      const reply = await handleFeedback({ body, session: SESSION, client, limiter: open });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: 'bad_request' });
    }

    expect(saved).toHaveLength(0);
  });

  it('says so when Supabase is not set up', async () => {
    const { client } = fakeClient({ isConfigured: () => false });

    const reply = await handleFeedback({
      body: { question_id: QUESTION, lang: 'en', vote: 'up' },
      session: SESSION,
      client,
      limiter: open,
    });

    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'not_configured' });
  });

  it('turns a thrown write into a fixed code, never the message', async () => {
    const { client } = fakeClient({
      save: async () => {
        throw new Error('https://project.supabase.co/rest/v1/ai_feedback 403');
      },
    });

    const reply = await handleFeedback({
      body: { question_id: QUESTION, lang: 'en', vote: 'down' },
      session: SESSION,
      client,
      limiter: open,
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'failed' });
    expect(JSON.stringify(reply.body)).not.toContain('supabase.co');
  });
});
