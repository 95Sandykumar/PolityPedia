/**
 * POST /api/teacher/exams decision logic (issue 07-next-exam-date-teacher-shell).
 *
 * The row owner is NEVER in the body: it comes from the session cookie, so
 * there is no field a caller could set to write teacher B's dates. This is
 * defence in depth; the gate is the `teacher_exams_write_own` policy inside
 * Postgres (0007).
 *
 * The client is a fake here: no real network call and no real key in any test
 * (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { handleTeacherExams } from '../teacher-exams-route';
import type { AuthSession } from '@/lib/auth/types';
import type { TeacherExam, TeacherExamsClient } from '../types';

const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    userId: '44444444-4444-4444-8444-444444444444',
    role: 'teacher',
    teacherStatus: 'approved',
    ...overrides,
  };
}

function fakeClient(overrides: Partial<TeacherExamsClient> = {}): TeacherExamsClient {
  return {
    isConfigured: () => true,
    listForTeacher: vi.fn(async () => []),
    saveMine: vi.fn(async () => {}),
    ...overrides,
  };
}

const ONE: TeacherExam[] = [{ examId: NET, nextExamDate: '2026-12-18', label: 'NET' }];

describe('handleTeacherExams', () => {
  it('saves the caller own list and echoes how many rows it kept', async () => {
    const client = fakeClient();
    const reply = await handleTeacherExams({
      body: { items: ONE },
      session: session(),
      client,
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, saved: 1 });
    expect(client.saveMine).toHaveBeenCalledWith(ONE);
  });

  it('accepts an empty list, which is how a teacher drops every exam', async () => {
    const client = fakeClient();
    const reply = await handleTeacherExams({ body: { items: [] }, session: session(), client });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, saved: 0 });
    expect(client.saveMine).toHaveBeenCalledWith([]);
  });

  it('accepts a row with no date and no label yet', async () => {
    const client = fakeClient();
    const items = [{ examId: CUET, nextExamDate: null, label: null }];
    const reply = await handleTeacherExams({ body: { items }, session: session(), client });

    expect(reply.status).toBe(200);
    expect(client.saveMine).toHaveBeenCalledWith(items);
  });

  it('answers 401 with no session and never calls the client', async () => {
    const client = fakeClient();
    const reply = await handleTeacherExams({ body: { items: ONE }, session: null, client });

    expect(reply.status).toBe(401);
    expect(client.saveMine).not.toHaveBeenCalled();
  });

  it('answers 403 for a student, who has no exam dates of their own', async () => {
    const client = fakeClient();
    const reply = await handleTeacherExams({
      body: { items: ONE },
      session: session({ role: 'student', teacherStatus: undefined }),
      client,
    });

    expect(reply.status).toBe(403);
    expect(client.saveMine).not.toHaveBeenCalled();
  });

  it('answers 503 when Supabase is not configured', async () => {
    const client = fakeClient({ isConfigured: () => false });
    const reply = await handleTeacherExams({ body: { items: ONE }, session: session(), client });

    expect(reply.status).toBe(503);
    expect(client.saveMine).not.toHaveBeenCalled();
  });

  it('answers 400 for every body shape that is not a clean list', async () => {
    const bodies: unknown[] = [
      null,
      'items',
      {},
      { items: 'NET' },
      { items: [{ examId: 'not-a-uuid', nextExamDate: null, label: null }] },
      { items: [{ examId: NET, nextExamDate: '18-12-2026', label: null }] },
      { items: [{ examId: NET, nextExamDate: '2026-02-30', label: null }] },
      { items: [{ examId: NET, nextExamDate: null, label: 'x'.repeat(25) }] },
      { items: [{ examId: NET, nextExamDate: null, label: 7 }] },
      // The same exam twice would be one upsert fighting itself.
      {
        items: [
          { examId: NET, nextExamDate: null, label: null },
          { examId: NET, nextExamDate: '2026-12-18', label: null },
        ],
      },
    ];

    for (const body of bodies) {
      const client = fakeClient();
      const reply = await handleTeacherExams({ body, session: session(), client });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(client.saveMine).not.toHaveBeenCalled();
    }
  });

  it('ignores a teacherId in the body: the owner comes from the session', async () => {
    const client = fakeClient();
    const reply = await handleTeacherExams({
      body: { teacherId: '99999999-9999-4999-8999-999999999999', items: ONE },
      session: session(),
      client,
    });

    expect(reply.status).toBe(200);
    expect(client.saveMine).toHaveBeenCalledWith(ONE);
  });

  it('answers 502 with a fixed message when the save throws', async () => {
    const client = fakeClient({
      saveMine: vi.fn(async () => {
        throw new Error('new row violates row-level security policy for table "teacher_exams"');
      }),
    });
    const reply = await handleTeacherExams({ body: { items: ONE }, session: session(), client });

    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: 'save failed' });
  });
});
