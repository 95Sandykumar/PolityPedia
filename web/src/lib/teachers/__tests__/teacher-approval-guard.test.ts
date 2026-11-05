/**
 * Issue 05-teacher-invite-approval: the middleware now also checks that a
 * teacher is APPROVED, not only that they are a teacher.
 *
 * A teacher who redeemed an invite has `profiles.role = 'teacher'` right away,
 * but `teachers.status = 'pending'` until an admin approves. Such a session may
 * see one page, `/teacher/pending`, and nothing else under `/teacher`.
 *
 * This is routing, not security. The gate is still RLS inside Postgres.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { TEACHER_PENDING_PATH, guard } from '@/lib/auth/guard';
import { SESSION_COOKIE, encodeSession, type AuthSession } from '@/lib/auth/session';
import { middleware } from '@/middleware';

const TEACHER_ID = '33333333-3333-4333-8333-333333333333';

function request(session?: Partial<AuthSession> & { role: AuthSession['role'] }) {
  const req = new NextRequest(new URL('https://politypedia.test/teacher/home'));
  if (session) {
    req.cookies.set(
      SESSION_COOKIE,
      encodeSession({
        accessToken: 'a.b.c',
        refreshToken: 'r',
        userId: TEACHER_ID,
        ...session,
      }),
    );
  }
  return req;
}

function location(res: Response): string | null {
  const raw = res.headers.get('location');
  return raw === null ? null : new URL(raw).pathname;
}

describe('guard with a teacher status', () => {
  it('sends a pending teacher to the pending page', () => {
    expect(guard({ pathname: '/teacher/home', role: 'teacher', teacherStatus: 'pending' })).toEqual({
      allow: false,
      redirectTo: TEACHER_PENDING_PATH,
    });
  });

  it('lets a pending teacher see the pending page itself', () => {
    expect(
      guard({ pathname: TEACHER_PENDING_PATH, role: 'teacher', teacherStatus: 'pending' }),
    ).toEqual({ allow: true });
  });

  it('lets an approved teacher into the teacher pages', () => {
    expect(guard({ pathname: '/teacher/home', role: 'teacher', teacherStatus: 'approved' })).toEqual(
      { allow: true },
    );
  });

  it('treats a missing status as pending, so it fails closed', () => {
    expect(guard({ pathname: '/teacher/home', role: 'teacher' })).toEqual({
      allow: false,
      redirectTo: TEACHER_PENDING_PATH,
    });
    expect(guard({ pathname: '/teacher/home', role: 'teacher', teacherStatus: null })).toEqual({
      allow: false,
      redirectTo: TEACHER_PENDING_PATH,
    });
  });

  it('does not ask an admin for a teacher status', () => {
    expect(guard({ pathname: '/teacher/home', role: 'admin' })).toEqual({ allow: true });
    expect(guard({ pathname: '/admin', role: 'admin' })).toEqual({ allow: true });
  });

  it('still sends a pending teacher away from an admin page to Home', () => {
    expect(guard({ pathname: '/admin', role: 'teacher', teacherStatus: 'pending' })).toEqual({
      allow: false,
      redirectTo: '/',
    });
  });

  it('leaves the student pages and the signup page open to a pending teacher', () => {
    for (const pathname of ['/', '/teachers', '/me', '/teacher-signup']) {
      expect(guard({ pathname, role: 'teacher', teacherStatus: 'pending' })).toEqual({
        allow: true,
      });
    }
  });

  it('keeps the invite-code page outside the guarded /teacher prefix', () => {
    // A candidate is still a student when they open it, so it must not be
    // behind the teacher guard.
    expect(guard({ pathname: '/teacher-signup', role: 'student' })).toEqual({ allow: true });
    expect(guard({ pathname: '/teacher-signup', role: null })).toEqual({ allow: true });
  });
});

describe('middleware carries the status out of the session cookie', () => {
  it('redirects a pending teacher to the pending page', () => {
    const res = middleware(request({ role: 'teacher', teacherStatus: 'pending' }));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(TEACHER_PENDING_PATH);
  });

  it('lets an approved teacher through', () => {
    const res = middleware(request({ role: 'teacher', teacherStatus: 'approved' }));
    expect(location(res)).toBeNull();
    expect(res.status).toBe(200);
  });

  it('treats an old cookie with no status as pending', () => {
    expect(location(middleware(request({ role: 'teacher' })))).toBe(TEACHER_PENDING_PATH);
  });
});
