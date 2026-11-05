/**
 * Issue 05-teacher-invite-approval: the rules behind POST /api/admin/teachers.
 *
 * Approving a teacher. Defence in depth only: the real gate is the
 * `teachers_admin_all` RLS policy plus the `teachers_block_admin_fields`
 * trigger inside Postgres, both proved in `test/teachers.test.ts`.
 *
 * A caller who is not an admin gets the same 403 whether or not Supabase is
 * configured, so this route cannot be used to probe the deployment.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import { handleAdminTeachers } from '../admin-teachers-route';
import type { TeachersClient } from '../types';

const ADMIN: AuthSession = {
  accessToken: 'a.b.c',
  refreshToken: 'r',
  userId: '99999999-9999-4999-8999-999999999999',
  role: 'admin',
};

const TEACHER = '44444444-4444-4444-8444-444444444444';

function fakeClient(overrides: Partial<TeachersClient> = {}): TeachersClient {
  return {
    isConfigured: () => true,
    redeemInvite: vi.fn(async () => {}),
    myStatus: vi.fn(async () => null),
    listPending: vi.fn(async () => []),
    approve: vi.fn(async () => {}),
    listPublic: vi.fn(async () => []),
    ...overrides,
  };
}

function run(body: unknown, session: AuthSession | null = ADMIN, client = fakeClient()) {
  return handleAdminTeachers({ body, session, client });
}

describe('handleAdminTeachers', () => {
  it('approves a teacher and records the admin who did it', async () => {
    const client = fakeClient();
    const reply = await run({ userId: TEACHER }, ADMIN, client);

    expect(client.approve).toHaveBeenCalledWith({ userId: TEACHER, approvedBy: ADMIN.userId });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
  });

  it('answers 401 when nobody is signed in', async () => {
    const client = fakeClient();
    expect((await run({ userId: TEACHER }, null, client)).status).toBe(401);
    expect(client.approve).not.toHaveBeenCalled();
  });

  it('answers 403 for a student or a teacher', async () => {
    for (const role of ['student', 'teacher'] as const) {
      const client = fakeClient();
      const reply = await run({ userId: TEACHER }, { ...ADMIN, role }, client);
      expect(reply.status).toBe(403);
      expect(client.approve).not.toHaveBeenCalled();
    }
  });

  it('answers 403 before it looks at the config, so the route cannot be probed', async () => {
    const reply = await run({ userId: TEACHER }, { ...ADMIN, role: 'student' }, fakeClient({
      isConfigured: () => false,
    }));
    expect(reply.status).toBe(403);
  });

  it('answers 503 when Supabase is not set up', async () => {
    const reply = await run({ userId: TEACHER }, ADMIN, fakeClient({ isConfigured: () => false }));
    expect(reply.status).toBe(503);
  });

  it('answers 400 for anything that is not a user id', async () => {
    for (const body of [null, {}, { userId: '' }, { userId: 'not-a-uuid' }, { userId: 42 }]) {
      const client = fakeClient();
      const reply = await run(body, ADMIN, client);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(client.approve).not.toHaveBeenCalled();
    }
  });

  it('answers 502 with a fixed message when the write fails', async () => {
    const reply = await run({ userId: TEACHER }, ADMIN, fakeClient({
      approve: vi.fn(async () => {
        throw new Error('new row violates row-level security policy teachers_admin_all');
      }),
    }));

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
    expect(JSON.stringify(reply.body)).not.toContain('policy');
  });
});
