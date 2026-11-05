/**
 * The decision logic behind POST/DELETE /api/admin/plans
 * (issue 21-plans-entitlements).
 *
 * Kept out of the route file so it can be driven directly, the same split as
 * `guard.ts` / `middleware.ts`. The PlansClient is a fake here: no real
 * network call and no real key.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleAdminPlans } from '../admin-plans-route';
import type { AuthSession } from '@/lib/auth/types';
import type { PlansClient } from '../types';

const STUDENT = '22222222-2222-4222-8222-222222222222';
const SOON = new Date(Date.now() + 30 * 86_400_000).toISOString();

function fakeClient(overrides: Partial<PlansClient> = {}): PlansClient {
  return {
    isConfigured: () => true,
    grant: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    canUse: vi.fn(async () => false),
    ...overrides,
  };
}

function session(role: AuthSession['role']): AuthSession {
  return { accessToken: 'a.b.c', refreshToken: 'r', userId: '1', role };
}

const GRANT_BODY = { userId: STUDENT, plan: 'ai', validUntil: SOON };

describe('who may call it', () => {
  it('401 with no session, and never touches Supabase', async () => {
    const client = fakeClient();
    const reply = await handleAdminPlans({
      method: 'POST',
      body: GRANT_BODY,
      session: null,
      client,
    });
    expect(reply.status).toBe(401);
    expect(client.grant).not.toHaveBeenCalled();
  });

  it('403 for a student and for a teacher', async () => {
    for (const role of ['student', 'teacher'] as const) {
      const client = fakeClient();
      const reply = await handleAdminPlans({
        method: 'POST',
        body: GRANT_BODY,
        session: session(role),
        client,
      });
      expect(reply.status).toBe(403);
      expect(client.grant).not.toHaveBeenCalled();
    }
  });

  it('checks the role before the config, so a probe learns nothing', async () => {
    const reply = await handleAdminPlans({
      method: 'POST',
      body: GRANT_BODY,
      session: session('student'),
      client: fakeClient({ isConfigured: () => false }),
    });
    expect(reply.status).toBe(403);
  });

  it('503 for an admin when Supabase is not set up', async () => {
    const reply = await handleAdminPlans({
      method: 'POST',
      body: GRANT_BODY,
      session: session('admin'),
      client: fakeClient({ isConfigured: () => false }),
    });
    expect(reply.status).toBe(503);
  });
});

describe('POST grants a plan', () => {
  it('passes the grant straight through and replies ok', async () => {
    const client = fakeClient();
    const reply = await handleAdminPlans({
      method: 'POST',
      body: GRANT_BODY,
      session: session('admin'),
      client,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(client.grant).toHaveBeenCalledWith({ userId: STUDENT, plan: 'ai', validUntil: SOON });
  });

  it('accepts pro too', async () => {
    const client = fakeClient();
    await handleAdminPlans({
      method: 'POST',
      body: { ...GRANT_BODY, plan: 'pro' },
      session: session('admin'),
      client,
    });
    expect(client.grant).toHaveBeenCalledWith(expect.objectContaining({ plan: 'pro' }));
  });

  it('400 on a bad body, a bad plan, a bad user id or a bad date', async () => {
    const bodies: unknown[] = [
      null,
      'nope',
      {},
      { ...GRANT_BODY, plan: 'platinum' },
      { ...GRANT_BODY, userId: 'not-a-uuid' },
      { ...GRANT_BODY, validUntil: 'soon' },
    ];
    for (const body of bodies) {
      const client = fakeClient();
      const reply = await handleAdminPlans({
        method: 'POST',
        body,
        session: session('admin'),
        client,
      });
      expect(reply.status).toBe(400);
      expect(client.grant).not.toHaveBeenCalled();
    }
  });

  it('400 on a valid_until in the past: ending a plan is DELETE, not a grant', async () => {
    const reply = await handleAdminPlans({
      method: 'POST',
      body: { ...GRANT_BODY, validUntil: new Date(Date.now() - 1000).toISOString() },
      session: session('admin'),
      client: fakeClient(),
    });
    expect(reply.status).toBe(400);
  });

  it('400 on a valid_until more than 400 days out, so a typo cannot gift years', async () => {
    const reply = await handleAdminPlans({
      method: 'POST',
      body: { ...GRANT_BODY, validUntil: new Date(Date.now() + 401 * 86_400_000).toISOString() },
      session: session('admin'),
      client: fakeClient(),
    });
    expect(reply.status).toBe(400);
  });

  it('502 with a fixed message when Postgres refuses, never the thrown text', async () => {
    const reply = await handleAdminPlans({
      method: 'POST',
      body: GRANT_BODY,
      session: session('admin'),
      client: fakeClient({
        grant: vi.fn(async () => {
          throw new Error('policy entitlements_admin_all says no');
        }),
      }),
    });
    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('entitlements_admin_all');
  });
});

describe('DELETE ends a plan', () => {
  it('needs only the user id and the plan', async () => {
    const client = fakeClient();
    const reply = await handleAdminPlans({
      method: 'DELETE',
      body: { userId: STUDENT, plan: 'pro' },
      session: session('admin'),
      client,
    });
    expect(reply.status).toBe(200);
    expect(client.end).toHaveBeenCalledWith({ userId: STUDENT, plan: 'pro' });
  });

  it('400 on a bad plan', async () => {
    const client = fakeClient();
    const reply = await handleAdminPlans({
      method: 'DELETE',
      body: { userId: STUDENT, plan: 'free' },
      session: session('admin'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.end).not.toHaveBeenCalled();
  });

  it('502 when the delete fails', async () => {
    const reply = await handleAdminPlans({
      method: 'DELETE',
      body: { userId: STUDENT, plan: 'ai' },
      session: session('admin'),
      client: fakeClient({
        end: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    });
    expect(reply.status).toBe(502);
  });
});
