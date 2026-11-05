/**
 * The decision logic behind POST/DELETE /api/admin/set-access
 * (issue 16-set-access-mock-list).
 *
 * Kept out of the route file so it can be driven directly. The
 * `SetAccessClient` is a fake here: no real network call and no real key.
 *
 * The point of these tests is that NOBODY but an admin gets as far as
 * Supabase. The policy would refuse them anyway, but a route that forwards a
 * student's grant request is a route that leaks whether the policy works.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleAdminSetAccess } from '../admin-set-access-route';
import type { AuthSession } from '@/lib/auth/types';
import type { SetAccessClient } from '../types';

const STUDENT = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const SOON = new Date(Date.now() + 30 * 86_400_000).toISOString();

function fakeClient(overrides: Partial<SetAccessClient> = {}): SetAccessClient {
  return {
    isConfigured: () => true,
    listMine: vi.fn(async () => []),
    listScores: vi.fn(async () => []),
    grant: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
}

function session(role: AuthSession['role']): AuthSession {
  return { accessToken: 'a.b.c', refreshToken: 'r', userId: '1', role };
}

const GRANT_BODY = { userId: STUDENT, setId: SET, validUntil: SOON };

describe('who may call it', () => {
  it('401 with no session, and never touches Supabase', async () => {
    const client = fakeClient();
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: null,
      client,
    });
    expect(reply.status).toBe(401);
    expect(client.grant).not.toHaveBeenCalled();
  });

  it('403 for a student', async () => {
    const client = fakeClient();
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(403);
    expect(client.grant).not.toHaveBeenCalled();
  });

  it('403 for a teacher: handing a set out is a batch, not a grant', async () => {
    const client = fakeClient();
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(403);
    expect(client.grant).not.toHaveBeenCalled();
  });

  it('403 before 503: a non-admin cannot probe whether Supabase is set up', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(403);
  });

  it('503 for an admin when Supabase is missing', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: session('admin'),
      client,
    });
    expect(reply.status).toBe(503);
    expect(client.grant).not.toHaveBeenCalled();
  });
});

describe('granting', () => {
  it('passes the two ids and the date through', async () => {
    const client = fakeClient();
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: session('admin'),
      client,
    });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(client.grant).toHaveBeenCalledWith({
      userId: STUDENT,
      setId: SET,
      validUntil: SOON,
    });
  });

  it('drops a source in the body: only admin grants come from this screen', async () => {
    const client = fakeClient();
    await handleAdminSetAccess({
      method: 'POST',
      body: { ...GRANT_BODY, source: 'purchase' },
      session: session('admin'),
      client,
    });
    expect(client.grant).toHaveBeenCalledWith({
      userId: STUDENT,
      setId: SET,
      validUntil: SOON,
    });
  });

  for (const [name, body] of [
    ['no body', null],
    ['a user id that is not a uuid', { ...GRANT_BODY, userId: 'me' }],
    ['a set id that is not a uuid', { ...GRANT_BODY, setId: 'that one' }],
    ['no set id', { userId: STUDENT, validUntil: SOON }],
    ['no date', { userId: STUDENT, setId: SET }],
    ['a date that is not a date', { ...GRANT_BODY, validUntil: 'soon' }],
    [
      'a date in the past',
      { ...GRANT_BODY, validUntil: new Date(Date.now() - 1000).toISOString() },
    ],
    [
      'a date ten years out',
      {
        ...GRANT_BODY,
        validUntil: new Date(Date.now() + 3650 * 86_400_000).toISOString(),
      },
    ],
  ] as const) {
    it(`400 for ${name}`, async () => {
      const client = fakeClient();
      const reply = await handleAdminSetAccess({
        method: 'POST',
        body,
        session: session('admin'),
        client,
      });
      expect(reply.status).toBe(400);
      expect(client.grant).not.toHaveBeenCalled();
    });
  }

  it('502 with a fixed message when Supabase refuses', async () => {
    const client = fakeClient({
      grant: vi.fn(async () => {
        throw new Error('new row violates row-level security policy for table "set_access"');
      }),
    });
    const reply = await handleAdminSetAccess({
      method: 'POST',
      body: GRANT_BODY,
      session: session('admin'),
      client,
    });
    expect(reply.status).toBe(502);
    // The policy name never reaches the browser.
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});

describe('revoking', () => {
  it('needs the two ids and no date', async () => {
    const client = fakeClient();
    const reply = await handleAdminSetAccess({
      method: 'DELETE',
      body: { userId: STUDENT, setId: SET },
      session: session('admin'),
      client,
    });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(client.revoke).toHaveBeenCalledWith({ userId: STUDENT, setId: SET });
  });

  it('400 without a set id, so one call cannot clear every set', async () => {
    const client = fakeClient();
    const reply = await handleAdminSetAccess({
      method: 'DELETE',
      body: { userId: STUDENT },
      session: session('admin'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.revoke).not.toHaveBeenCalled();
  });
});
