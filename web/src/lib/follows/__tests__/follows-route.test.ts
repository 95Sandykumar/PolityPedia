/**
 * The decision logic behind POST /api/follows (issue 06-portfolio-follow).
 *
 * Defence in depth, not the gate. The gate is the `follows_insert_own` and
 * `follows_delete_own` policies inside Postgres. These tests prove the route
 * answers with fixed messages and never leans on the body to decide WHO the
 * row belongs to: that comes from the session only.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleFollows } from '../follows-route';
import type { FollowsClient } from '../types';
import type { AuthSession } from '@/lib/auth/types';

const STUDENT: AuthSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
};

const TEACHER = '44444444-4444-4444-8444-444444444444';

function fakeClient(overrides: Partial<FollowsClient> = {}): FollowsClient {
  return {
    isConfigured: () => true,
    listFollowing: vi.fn(async () => []),
    follow: vi.fn(async () => {}),
    unfollow: vi.fn(async () => {}),
    ...overrides,
  };
}

function run(body: unknown, session: AuthSession | null = STUDENT, client = fakeClient()) {
  return handleFollows({ body, session, client });
}

describe('handleFollows', () => {
  it('follows and reports the new button state', async () => {
    const client = fakeClient();
    const reply = await run({ teacherId: TEACHER, following: true }, STUDENT, client);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, following: true });
    expect(client.follow).toHaveBeenCalledWith(TEACHER);
    expect(client.unfollow).not.toHaveBeenCalled();
  });

  it('unfollows when following is false', async () => {
    const client = fakeClient();
    const reply = await run({ teacherId: TEACHER, following: false }, STUDENT, client);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, following: false });
    expect(client.unfollow).toHaveBeenCalledWith(TEACHER);
    expect(client.follow).not.toHaveBeenCalled();
  });

  it('answers 401 with no session, and never calls Supabase', async () => {
    const client = fakeClient();
    const reply = await run({ teacherId: TEACHER, following: true }, null, client);

    expect(reply.status).toBe(401);
    expect(client.follow).not.toHaveBeenCalled();
  });

  it('answers 503 when Supabase is not configured', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await run({ teacherId: TEACHER, following: true }, STUDENT, client);

    expect(reply.status).toBe(503);
    expect(client.follow).not.toHaveBeenCalled();
  });

  it.each([
    ['null body', null],
    ['no teacherId', { following: true }],
    ['teacherId is not a uuid', { teacherId: 'nope', following: true }],
    ['following is not a boolean', { teacherId: TEACHER, following: 'yes' }],
    ['following is missing', { teacherId: TEACHER }],
    ['a string body', 'teacherId=x'],
  ])('answers 400 for %s', async (_label, body) => {
    const client = fakeClient();
    const reply = await run(body, STUDENT, client);

    expect(reply.status).toBe(400);
    expect(client.follow).not.toHaveBeenCalled();
    expect(client.unfollow).not.toHaveBeenCalled();
  });

  it('ignores a userId in the body: the row owner comes from the session', async () => {
    const client = fakeClient();
    const reply = await run(
      { teacherId: TEACHER, following: true, userId: '99999999-9999-4999-8999-999999999999' },
      STUDENT,
      client,
    );

    expect(reply.status).toBe(200);
    // One argument only, so there is no seam for another user's id.
    expect(client.follow).toHaveBeenCalledWith(TEACHER);
  });

  it('answers 502 with a fixed message when the write fails', async () => {
    const client = fakeClient({
      follow: vi.fn(async () => {
        throw new Error('403 new row violates policy follows_insert_own');
      }),
    });
    const reply = await run({ teacherId: TEACHER, following: true }, STUDENT, client);

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
    expect(JSON.stringify(reply.body)).not.toContain('follows_insert_own');
  });
});
