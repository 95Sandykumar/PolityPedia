/**
 * POST /api/saved, the decision logic (issue 14-saved-list).
 *
 * The client is a FAKE, so no test makes a network call and no test holds a
 * key (web/CLAUDE.md). The real gate is RLS in `0014_saved.sql`; this file
 * proves the route never looks at a body before it knows who is asking, and
 * never lets a reply quote Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleSaved } from '../saved-route';
import type { SavedClient, SavedTag } from '../types';
import type { AuthSession } from '@/lib/auth/types';

const Q1 = '22222222-2222-4222-8222-222222222221';

const SESSION: AuthSession = {
  userId: '33333333-3333-4333-8333-333333333333',
  accessToken: 'student-token',
  refreshToken: 'student-refresh',
  role: 'student',
};

function client(overrides: Partial<SavedClient> = {}): SavedClient {
  return {
    isConfigured: () => true,
    list: vi.fn(async () => []),
    save: vi.fn(async (_questionId: string, _tag: SavedTag) => {}),
    remove: vi.fn(async (_questionId: string, _tag: SavedTag) => {}),
    ...overrides,
  };
}

describe('handleSaved', () => {
  it('turns away a caller who is not signed in, before the body', async () => {
    const save = vi.fn(async () => {});
    const reply = await handleSaved({
      body: { questionId: Q1, tag: 'wrong', saved: true },
      session: null,
      client: client({ save }),
    });

    expect(reply.status).toBe(401);
    expect(save).not.toHaveBeenCalled();
  });

  it('says so when Supabase is not set up', async () => {
    const reply = await handleSaved({
      body: { questionId: Q1, tag: 'wrong', saved: true },
      session: SESSION,
      client: client({ isConfigured: () => false }),
    });

    expect(reply.status).toBe(503);
  });

  it('saves the tag and echoes the state back', async () => {
    const save = vi.fn(async () => {});
    const reply = await handleSaved({
      body: { questionId: Q1, tag: 'wrong', saved: true },
      session: SESSION,
      client: client({ save }),
    });

    expect(save).toHaveBeenCalledWith(Q1, 'wrong');
    expect(reply).toEqual({ status: 200, body: { ok: true, saved: true } });
  });

  it('removes the tag when the body asks for it', async () => {
    const remove = vi.fn(async () => {});
    const reply = await handleSaved({
      body: { questionId: Q1, tag: 'marked', saved: false },
      session: SESSION,
      client: client({ remove }),
    });

    expect(remove).toHaveBeenCalledWith(Q1, 'marked');
    expect(reply).toEqual({ status: 200, body: { ok: true, saved: false } });
  });

  it('refuses a bad body with no call at all', async () => {
    const save = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const reply = await handleSaved({
      body: { questionId: Q1, tag: 'later', saved: true },
      session: SESSION,
      client: client({ save, remove }),
    });

    expect(reply.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('answers 502 with a fixed word when Supabase fails', async () => {
    const reply = await handleSaved({
      body: { questionId: Q1, tag: 'wrong', saved: true },
      session: SESSION,
      client: client({
        save: vi.fn(async () => {
          throw new Error('new row violates row-level security policy for table');
        }),
      }),
    });

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toMatch(/row-level|policy/i);
  });
});
