/**
 * Issue 05-teacher-invite-approval: the rules behind POST /api/teacher/signup.
 *
 * A signed-in student posts the invite code they were sent. The route spends
 * the code through the SQL function, which is where single use is enforced.
 * The route never says WHY a code failed, so it cannot be used to tell
 * "already used" apart from "never existed".
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { handleTeacherSignup } from '../teacher-signup-route';
import type { TeachersClient } from '../types';

const STUDENT: AuthSession = {
  accessToken: 'a.b.c',
  refreshToken: 'r',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
};

function fakeClient(overrides: Partial<TeachersClient> = {}): TeachersClient {
  return {
    isConfigured: () => true,
    redeemInvite: vi.fn(async () => {}),
    myStatus: vi.fn(async () => 'pending' as const),
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => {}),
    listPublic: vi.fn(async () => []),
    readPublic: vi.fn(async () => null),
    listPublicByIds: vi.fn(async () => []),
    listCards: vi.fn(async () => []),
    readCard: vi.fn(async () => null),
    ...overrides,
  };
}

function run(body: unknown, session: AuthSession | null = STUDENT, client = fakeClient()) {
  return handleTeacherSignup({ body, session, client });
}

describe('handleTeacherSignup', () => {
  it('spends the code and answers pending', async () => {
    const client = fakeClient();
    const reply = await run({ code: 'INVITE-ONE' }, STUDENT, client);

    expect(client.redeemInvite).toHaveBeenCalledWith('INVITE-ONE');
    expect(reply).toEqual({ status: 200, body: { ok: true, status: 'pending' } });
  });

  it('trims the code, because a pasted code carries spaces', async () => {
    const client = fakeClient();
    await run({ code: '  INVITE-ONE \n' }, STUDENT, client);
    expect(client.redeemInvite).toHaveBeenCalledWith('INVITE-ONE');
  });

  it('answers 401 when nobody is signed in', async () => {
    const client = fakeClient();
    const reply = await run({ code: 'INVITE-ONE' }, null, client);
    expect(reply.status).toBe(401);
    expect(client.redeemInvite).not.toHaveBeenCalled();
  });

  it('answers 403 for somebody who is already a teacher or an admin', async () => {
    for (const role of ['teacher', 'admin'] as const) {
      const client = fakeClient();
      const reply = await run({ code: 'INVITE-ONE' }, { ...STUDENT, role }, client);
      expect(reply.status).toBe(403);
      expect(client.redeemInvite).not.toHaveBeenCalled();
    }
  });

  it('answers 503 when Supabase is not set up', async () => {
    const reply = await run({ code: 'INVITE-ONE' }, STUDENT, fakeClient({
      isConfigured: () => false,
    }));
    expect(reply.status).toBe(503);
  });

  it('answers 400 for a missing, empty or over-long code', async () => {
    for (const body of [null, {}, { code: '' }, { code: '   ' }, { code: 7 }, { code: 'x'.repeat(65) }]) {
      const client = fakeClient();
      const reply = await run(body, STUDENT, client);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(client.redeemInvite).not.toHaveBeenCalled();
    }
  });

  it('answers 400 with a fixed message when the code is used or unknown', async () => {
    const reply = await run({ code: 'INVITE-ONE' }, STUDENT, fakeClient({
      redeemInvite: vi.fn(async () => {
        throw new Error('invite code is not valid (policy teacher_invites_admin_all)');
      }),
    }));

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'invalid code' });
    // The Postgres text must never reach the browser.
    expect(JSON.stringify(reply.body)).not.toContain('policy');
  });
});
