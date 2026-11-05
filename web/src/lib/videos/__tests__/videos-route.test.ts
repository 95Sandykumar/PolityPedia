/**
 * Issue 08-videos-tile: the decision logic behind POST /api/teacher/videos.
 *
 * Three actions on one route: add a link, delete a row, flip Show / No show.
 * The client and the title reader are both injected, so nothing here makes a
 * real network call and no key appears (web/CLAUDE.md).
 *
 * Order of checks: session, then role, then config, then the body.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleTeacherVideos } from '../videos-route';
import type { TeacherVideo, VideoMeta, VideosClient } from '../types';
import type { AuthSession } from '@/lib/auth/types';

const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = '22222222-2222-4222-8222-222222222222';
const YT = 'dQw4w9WgXcQ';

const teacher: AuthSession = {
  accessToken: 'token',
  refreshToken: 'refresh',
  userId: TEACHER_ID,
  role: 'teacher',
  teacherStatus: 'approved',
};

const student: AuthSession = { ...teacher, role: 'student', teacherStatus: undefined };

function row(youtubeId: string, position: number): TeacherVideo {
  return {
    id: VIDEO_ID,
    teacherId: TEACHER_ID,
    youtubeId,
    title: 'Polity',
    thumbUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    position,
  };
}

function fakeClient(overrides: Partial<VideosClient> = {}): VideosClient {
  return {
    isConfigured: () => true,
    listMine: vi.fn(async () => [] as TeacherVideo[]),
    listForTeacher: vi.fn(async () => [] as TeacherVideo[]),
    add: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    readVisible: vi.fn(async () => true),
    setVisible: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeMeta(title: string | null = 'Indian Constitution in 10 minutes'): VideoMeta {
  return { readTitle: vi.fn(async () => title) };
}

describe('handleTeacherVideos: who may call', () => {
  it('answers 401 with no session', async () => {
    const reply = await handleTeacherVideos({
      body: { action: 'add', url: `https://youtu.be/${YT}` },
      session: null,
      client: fakeClient(),
      meta: fakeMeta(),
    });
    expect(reply.status).toBe(401);
  });

  it('answers 403 for a student', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'add', url: `https://youtu.be/${YT}` },
      session: student,
      client,
      meta: fakeMeta(),
    });
    expect(reply.status).toBe(403);
    expect(client.add).not.toHaveBeenCalled();
  });

  it('answers 503 when Supabase is not configured', async () => {
    const reply = await handleTeacherVideos({
      body: { action: 'visible', visible: false },
      session: teacher,
      client: fakeClient({ isConfigured: () => false }),
      meta: fakeMeta(),
    });
    expect(reply.status).toBe(503);
  });
});

describe('handleTeacherVideos: add', () => {
  it('parses the link, fills the title from oEmbed and stores the thumbnail', async () => {
    const client = fakeClient();
    const meta = fakeMeta('Indian Constitution in 10 minutes');

    const reply = await handleTeacherVideos({
      body: { action: 'add', url: `https://www.youtube.com/watch?v=${YT}&t=10` },
      session: teacher,
      client,
      meta,
    });

    expect(reply.status).toBe(200);
    expect(meta.readTitle).toHaveBeenCalledWith(YT);
    expect(client.add).toHaveBeenCalledWith({
      youtubeId: YT,
      title: 'Indian Constitution in 10 minutes',
      thumbUrl: `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
      position: 0,
    });
  });

  it('puts a new link after the ones already there', async () => {
    const client = fakeClient({
      listMine: vi.fn(async () => [row('aaaaaaaaaaa', 0), row('bbbbbbbbbbb', 1)]),
    });

    await handleTeacherVideos({
      body: { action: 'add', url: `https://youtu.be/${YT}` },
      session: teacher,
      client,
      meta: fakeMeta(),
    });

    expect(client.add).toHaveBeenCalledWith(expect.objectContaining({ position: 2 }));
  });

  it('still stores the row when oEmbed gives no title', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'add', url: `https://www.youtube.com/shorts/${YT}` },
      session: teacher,
      client,
      meta: fakeMeta(null),
    });

    expect(reply.status).toBe(200);
    expect(client.add).toHaveBeenCalledWith(expect.objectContaining({ title: null }));
  });

  it('answers 400 for a link that is not YouTube, and stores nothing', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'add', url: 'https://vimeo.com/76979871' },
      session: teacher,
      client,
      meta: fakeMeta(),
    });

    expect(reply.status).toBe(400);
    expect(client.add).not.toHaveBeenCalled();
  });

  it('answers 400 for rubbish in the body', async () => {
    const client = fakeClient();
    for (const body of [null, 'add', {}, { action: 'add' }, { action: 'nope', url: 'x' }]) {
      const reply = await handleTeacherVideos({
        body,
        session: teacher,
        client,
        meta: fakeMeta(),
      });
      expect(reply.status).toBe(400);
    }
    expect(client.add).not.toHaveBeenCalled();
  });

  it('answers 502 with a fixed message when the write fails', async () => {
    const reply = await handleTeacherVideos({
      body: { action: 'add', url: `https://youtu.be/${YT}` },
      session: teacher,
      client: fakeClient({
        add: vi.fn(async () => {
          throw new Error('403 row-level security policy teacher_videos_insert_own');
        }),
      }),
      meta: fakeMeta(),
    });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});

describe('handleTeacherVideos: remove', () => {
  it('deletes the named row', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'remove', id: VIDEO_ID },
      session: teacher,
      client,
      meta: fakeMeta(),
    });

    expect(reply.status).toBe(200);
    expect(client.remove).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('answers 400 when the id is not a uuid', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'remove', id: 'not-a-uuid' },
      session: teacher,
      client,
      meta: fakeMeta(),
    });

    expect(reply.status).toBe(400);
    expect(client.remove).not.toHaveBeenCalled();
  });
});

describe('handleTeacherVideos: Show / No show', () => {
  it('writes the switch and echoes the new state back', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'visible', visible: false },
      session: teacher,
      client,
      meta: fakeMeta(),
    });

    expect(client.setVisible).toHaveBeenCalledWith(false);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, visible: false });
  });

  it('refuses a truthy value that is not a boolean', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'visible', visible: 'false' },
      session: teacher,
      client,
      meta: fakeMeta(),
    });

    expect(reply.status).toBe(400);
    expect(client.setVisible).not.toHaveBeenCalled();
  });

  it('lets an admin flip it too', async () => {
    const client = fakeClient();
    const reply = await handleTeacherVideos({
      body: { action: 'visible', visible: true },
      session: { ...teacher, role: 'admin' },
      client,
      meta: fakeMeta(),
    });
    expect(reply.status).toBe(200);
  });
});
