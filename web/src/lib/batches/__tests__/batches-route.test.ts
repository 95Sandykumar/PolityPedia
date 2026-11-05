/**
 * The decision logic behind the four batch routes (issue 19-batches).
 *
 * Kept out of the route files so the tests drive it directly. The
 * `BatchesClient` is a fake here: no real network call and no real key.
 *
 * The point of these tests is the shape of the gate, not the gate itself. The
 * real one is `0019_batches.sql`. What is checked here:
 *
 *   * a student never reaches the teacher writes,
 *   * JOINING is a student action, so it must NOT be behind the teacher gate,
 *   * the batch id comes from the path and the owner from the session, so
 *     there is no body field that moves either,
 *   * a bad join code is a 404 with one short word, never a Postgres message.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import {
  handleJoinBatch,
  handleRemoveMember,
  handleSaveBatch,
  handleSetBatchSet,
} from '../batches-route';
import type { Batch, BatchesClient } from '../types';

const BATCH = '11111111-1111-4111-8111-111111111111';
const SET = '33333333-3333-4333-8333-333333333333';
const STUDENT = '22222222-2222-4222-8222-222222222222';

const SAVED: Batch = {
  id: BATCH,
  teacherId: '44444444-4444-4444-8444-444444444444',
  name: 'Morning batch',
  joinCode: 'ABC234',
};

function fakeClient(overrides: Partial<BatchesClient> = {}): BatchesClient {
  return {
    isConfigured: () => true,
    listMine: vi.fn(async () => []),
    readOne: vi.fn(async () => null),
    saveBatch: vi.fn(async () => SAVED),
    listMembers: vi.fn(async () => []),
    removeMember: vi.fn(async () => {}),
    listSets: vi.fn(async () => []),
    addSet: vi.fn(async () => {}),
    dropSet: vi.fn(async () => {}),
    join: vi.fn(async () => BATCH),
    ...overrides,
  };
}

function session(role: AuthSession['role']): AuthSession {
  return { accessToken: 'a.b.c', refreshToken: 'r', userId: '1', role };
}

describe('POST /api/teacher/batches', () => {
  it('401 with no session, and never touches Supabase', async () => {
    const client = fakeClient();
    const reply = await handleSaveBatch({
      body: { id: null, name: 'Morning batch' },
      session: null,
      client,
    });
    expect(reply.status).toBe(401);
    expect(client.saveBatch).not.toHaveBeenCalled();
  });

  it('403 for a student: a batch belongs to a teacher', async () => {
    const client = fakeClient();
    const reply = await handleSaveBatch({
      body: { id: null, name: 'Morning batch' },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(403);
    expect(client.saveBatch).not.toHaveBeenCalled();
  });

  it('503 when Supabase is not configured', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await handleSaveBatch({
      body: { id: null, name: 'Morning batch' },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(503);
  });

  it('creates a batch and answers with the row, join code included', async () => {
    const client = fakeClient();
    const reply = await handleSaveBatch({
      body: { id: null, name: '  Morning batch ' },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, batch: SAVED });
    // The name is trimmed before it travels.
    expect(client.saveBatch).toHaveBeenCalledWith({ id: null, name: 'Morning batch' });
  });

  it('renames an existing batch when the body carries its id', async () => {
    const client = fakeClient();
    await handleSaveBatch({
      body: { id: BATCH, name: 'Evening batch' },
      session: session('teacher'),
      client,
    });
    expect(client.saveBatch).toHaveBeenCalledWith({ id: BATCH, name: 'Evening batch' });
  });

  it('400 for a blank name', async () => {
    const client = fakeClient();
    const reply = await handleSaveBatch({
      body: { id: null, name: '   ' },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.saveBatch).not.toHaveBeenCalled();
  });

  it('400 for an id that is not a uuid', async () => {
    const client = fakeClient();
    const reply = await handleSaveBatch({
      body: { id: 'not-a-uuid', name: 'Morning batch' },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.saveBatch).not.toHaveBeenCalled();
  });

  it('drops a teacherId and a joinCode a caller tried to set', async () => {
    const client = fakeClient();
    await handleSaveBatch({
      body: {
        id: null,
        name: 'Morning batch',
        teacherId: STUDENT,
        joinCode: 'AAAAAA',
      },
      session: session('teacher'),
      client,
    });
    // Only the two fields a teacher may choose travel. The owner comes from
    // the session and the code from the database default.
    expect(client.saveBatch).toHaveBeenCalledWith({ id: null, name: 'Morning batch' });
  });

  it('502 with one short word when the save blows up', async () => {
    const client = fakeClient({
      saveBatch: vi.fn(async () => {
        throw new Error('new row violates row-level security policy for "batches"');
      }),
    });
    const reply = await handleSaveBatch({
      body: { id: null, name: 'Morning batch' },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});

describe('POST /api/teacher/batches/<batchId>/members', () => {
  it('403 for a student', async () => {
    const client = fakeClient();
    const reply = await handleRemoveMember({
      batchId: BATCH,
      body: { userId: STUDENT },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(403);
    expect(client.removeMember).not.toHaveBeenCalled();
  });

  it('removes the student named in the body from the batch in the path', async () => {
    const client = fakeClient();
    const reply = await handleRemoveMember({
      batchId: BATCH,
      body: { userId: STUDENT },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(client.removeMember).toHaveBeenCalledWith(BATCH, STUDENT);
  });

  it('400 for a batch id that is not a uuid', async () => {
    const client = fakeClient();
    const reply = await handleRemoveMember({
      batchId: 'nope',
      body: { userId: STUDENT },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.removeMember).not.toHaveBeenCalled();
  });

  it('400 for a user id that is not a uuid', async () => {
    const client = fakeClient();
    const reply = await handleRemoveMember({
      batchId: BATCH,
      body: { userId: 'everyone' },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.removeMember).not.toHaveBeenCalled();
  });
});

describe('POST /api/teacher/batches/<batchId>/sets', () => {
  it('adds the set when free is true', async () => {
    const client = fakeClient();
    const reply = await handleSetBatchSet({
      batchId: BATCH,
      body: { setId: SET, free: true },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(200);
    expect(client.addSet).toHaveBeenCalledWith(BATCH, SET);
    expect(client.dropSet).not.toHaveBeenCalled();
  });

  it('drops the set when free is false', async () => {
    const client = fakeClient();
    await handleSetBatchSet({
      batchId: BATCH,
      body: { setId: SET, free: false },
      session: session('teacher'),
      client,
    });
    expect(client.dropSet).toHaveBeenCalledWith(BATCH, SET);
    expect(client.addSet).not.toHaveBeenCalled();
  });

  it('400 when free is missing: a half-read toggle must not guess', async () => {
    const client = fakeClient();
    const reply = await handleSetBatchSet({
      batchId: BATCH,
      body: { setId: SET },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(client.addSet).not.toHaveBeenCalled();
    expect(client.dropSet).not.toHaveBeenCalled();
  });

  it('403 for a student', async () => {
    const client = fakeClient();
    const reply = await handleSetBatchSet({
      batchId: BATCH,
      body: { setId: SET, free: true },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(403);
    expect(client.addSet).not.toHaveBeenCalled();
  });

  it('400 for a set id that is not a uuid', async () => {
    const client = fakeClient();
    const reply = await handleSetBatchSet({
      batchId: BATCH,
      body: { setId: 'all of them', free: true },
      session: session('teacher'),
      client,
    });
    expect(reply.status).toBe(400);
  });
});

describe('POST /api/batches/join', () => {
  it('lets a STUDENT join: joining is not behind the teacher gate', async () => {
    const client = fakeClient();
    const reply = await handleJoinBatch({
      body: { code: 'abc234' },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, batchId: BATCH });
    // Normalised on the way in, so a pasted code with a space still works.
    expect(client.join).toHaveBeenCalledWith('ABC234');
  });

  it('401 with no session', async () => {
    const client = fakeClient();
    const reply = await handleJoinBatch({
      body: { code: 'ABC234' },
      session: null,
      client,
    });
    expect(reply.status).toBe(401);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('400 for a code that cannot be a join code at all', async () => {
    const client = fakeClient();
    const reply = await handleJoinBatch({
      body: { code: 'OOPS' },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ error: 'bad code' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('404 with one short word when no batch has that code', async () => {
    const client = fakeClient({
      join: vi.fn(async () => {
        throw Object.assign(new Error('join refused'), { name: 'JoinNotFound' });
      }),
    });
    const reply = await handleJoinBatch({
      body: { code: 'ZZZZZZ' },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ error: 'bad code' });
  });

  it('502 with one short word for anything else, never a Postgres message', async () => {
    const client = fakeClient({
      join: vi.fn(async () => {
        throw new Error('permission denied for function join_batch');
      }),
    });
    const reply = await handleJoinBatch({
      body: { code: 'ABC234' },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'join failed' });
  });

  it('503 when Supabase is not configured', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await handleJoinBatch({
      body: { code: 'ABC234' },
      session: session('student'),
      client,
    });
    expect(reply.status).toBe(503);
  });
});
