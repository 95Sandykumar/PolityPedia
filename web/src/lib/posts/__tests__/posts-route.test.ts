/**
 * The decision logic behind /api/teacher/posts (issue 09-teacher-notifications).
 *
 * Defence in depth, not the gate. The gate is the `teacher_posts_insert_own`
 * and `teacher_posts_delete_own` policies inside Postgres. These tests prove
 * the route answers with fixed messages and never lets the body decide WHO the
 * post belongs to: that comes from the session only.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleCreatePost, handleDeletePost } from '../posts-route';
import type { TeacherPost, TeacherPostsClient } from '../types';
import type { AuthSession } from '@/lib/auth/types';

const TEACHER: AuthSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  userId: '44444444-4444-4444-8444-444444444444',
  role: 'teacher',
  teacherStatus: 'approved',
};

const STUDENT: AuthSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
};

const POST_ID = '99999999-9999-4999-8999-999999999999';

const SAVED: TeacherPost = {
  id: POST_ID,
  teacherId: TEACHER.userId,
  priority: 1,
  heading: 'NET form is out',
  link: 'https://ugcnet.nta.ac.in',
  createdAt: '2026-11-05T10:00:00Z',
};

function fakeClient(overrides: Partial<TeacherPostsClient> = {}): TeacherPostsClient {
  return {
    isConfigured: () => true,
    listForTeacher: vi.fn(async () => []),
    listForTeachers: vi.fn(async () => []),
    listMine: vi.fn(async () => []),
    create: vi.fn(async () => SAVED),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('handleCreatePost', () => {
  it('saves a post and hands the stored row back', async () => {
    const client = fakeClient();
    const reply = await handleCreatePost({
      body: { heading: '  NET form is out  ', priority: 1, link: 'https://ugcnet.nta.ac.in' },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ ok: true, post: SAVED });
    // Trimmed before it ever reaches Supabase.
    expect(client.create).toHaveBeenCalledWith({
      heading: 'NET form is out',
      priority: 1,
      link: 'https://ugcnet.nta.ac.in',
    });
  });

  it('defaults the priority to normal and the link to nothing', async () => {
    const client = fakeClient();
    const reply = await handleCreatePost({
      body: { heading: 'Class at 6' },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(201);
    expect(client.create).toHaveBeenCalledWith({
      heading: 'Class at 6',
      priority: 0,
      link: null,
    });
  });

  it('answers 401 with no session, and never calls Supabase', async () => {
    const client = fakeClient();
    const reply = await handleCreatePost({
      body: { heading: 'Hello' },
      session: null,
      client,
    });

    expect(reply.status).toBe(401);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('answers 403 for a student, so only a teacher may post', async () => {
    const client = fakeClient();
    const reply = await handleCreatePost({
      body: { heading: 'Hello' },
      session: STUDENT,
      client,
    });

    expect(reply.status).toBe(403);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('answers 403 for a teacher who is still waiting for approval', async () => {
    const client = fakeClient();
    const reply = await handleCreatePost({
      body: { heading: 'Hello' },
      session: { ...TEACHER, teacherStatus: 'pending' },
      client,
    });

    expect(reply.status).toBe(403);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('answers 503 when Supabase is not configured', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await handleCreatePost({
      body: { heading: 'Hello' },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(503);
    expect(client.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a null body', null],
    ['a string body', 'heading=x'],
    ['no heading', { priority: 1 }],
    ['a blank heading', { heading: '   ' }],
    ['an over-long heading', { heading: 'x'.repeat(201) }],
    ['a heading that is not a string', { heading: 42 }],
    ['a priority that is not one of ours', { heading: 'Hi', priority: 9 }],
    ['a priority as a string', { heading: 'Hi', priority: '1' }],
    ['a link with another scheme', { heading: 'Hi', link: 'javascript:alert(1)' }],
    ['a link that is not a string', { heading: 'Hi', link: 7 }],
  ])('answers 400 for %s', async (_label, body) => {
    const client = fakeClient();
    const reply = await handleCreatePost({ body, session: TEACHER, client });

    expect(reply.status).toBe(400);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('ignores a teacherId in the body: the author comes from the session', async () => {
    const client = fakeClient();
    const reply = await handleCreatePost({
      body: { heading: 'Mine', teacherId: STUDENT.userId },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(201);
    // Three fields only, so there is no seam for another teacher's id.
    expect(client.create).toHaveBeenCalledWith({
      heading: 'Mine',
      priority: 0,
      link: null,
    });
  });

  it('answers 502 with a fixed message when the write fails', async () => {
    const client = fakeClient({
      create: vi.fn(async () => {
        throw new Error('403 new row violates policy teacher_posts_insert_own');
      }),
    });
    const reply = await handleCreatePost({
      body: { heading: 'Hello' },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
    expect(JSON.stringify(reply.body)).not.toContain('teacher_posts_insert_own');
  });
});

describe('handleDeletePost', () => {
  it('deletes one post of the caller', async () => {
    const client = fakeClient();
    const reply = await handleDeletePost({
      body: { postId: POST_ID },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expect(client.remove).toHaveBeenCalledWith(POST_ID);
  });

  it('answers 401 with no session', async () => {
    const client = fakeClient();
    const reply = await handleDeletePost({ body: { postId: POST_ID }, session: null, client });

    expect(reply.status).toBe(401);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('answers 403 for a student', async () => {
    const client = fakeClient();
    const reply = await handleDeletePost({
      body: { postId: POST_ID },
      session: STUDENT,
      client,
    });

    expect(reply.status).toBe(403);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['a null body', null],
    ['no postId', {}],
    ['a postId that is not a uuid', { postId: 'nope' }],
    ['a postId that is not a string', { postId: 7 }],
  ])('answers 400 for %s', async (_label, body) => {
    const client = fakeClient();
    const reply = await handleDeletePost({ body, session: TEACHER, client });

    expect(reply.status).toBe(400);
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('answers 502 with a fixed message when the delete fails', async () => {
    const client = fakeClient({
      remove: vi.fn(async () => {
        throw new Error('403 policy teacher_posts_delete_own');
      }),
    });
    const reply = await handleDeletePost({
      body: { postId: POST_ID },
      session: TEACHER,
      client,
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
    expect(JSON.stringify(reply.body)).not.toContain('teacher_posts_delete_own');
  });
});
