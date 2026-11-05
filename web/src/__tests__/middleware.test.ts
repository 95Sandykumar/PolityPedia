/**
 * Issue 03-sign-in: the real middleware, exercised through NextRequest.
 * Definition of done: a student who opens /teacher or /admin is sent back to Home.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, middleware } from '../middleware';
import { MIDDLEWARE_MATCHER } from '@/lib/auth/guard';
import {
  SESSION_COOKIE,
  encodeSession,
  type Role,
  type TeacherStatus,
} from '@/lib/auth/session';

function request(pathname: string, role?: Role, teacherStatus?: TeacherStatus) {
  const req = new NextRequest(new URL('https://politypedia.test' + pathname));
  if (role) {
    req.cookies.set(
      SESSION_COOKIE,
      encodeSession({
        accessToken: 'a.b.c',
        refreshToken: 'r',
        userId: '11111111-1111-4111-8111-111111111111',
        role,
        ...(teacherStatus ? { teacherStatus } : {}),
      }),
    );
  }
  return req;
}

function location(res: Response): string | null {
  const raw = res.headers.get('location');
  return raw === null ? null : new URL(raw).pathname;
}

describe('middleware', () => {
  it('redirects a student from /teacher/home to /', () => {
    const res = middleware(request('/teacher/home', 'student'));
    expect(res.status).toBe(307);
    expect(location(res)).toBe('/');
  });

  it('redirects a student from /admin to /', () => {
    expect(location(middleware(request('/admin', 'student')))).toBe('/');
  });

  it('redirects a visitor with no cookie to /sign-in', () => {
    expect(location(middleware(request('/teacher/home')))).toBe('/sign-in');
  });

  // Issue 05-teacher-invite-approval: a teacher also has to be approved.
  it('lets an approved teacher into /teacher/home', () => {
    const res = middleware(request('/teacher/home', 'teacher', 'approved'));
    expect(location(res)).toBeNull();
    expect(res.status).toBe(200);
  });

  it('lets a student into Home and the sign-in page', () => {
    expect(location(middleware(request('/', 'student')))).toBeNull();
    expect(location(middleware(request('/sign-in')))).toBeNull();
  });

  it('ignores a forged cookie value and treats it as no session', () => {
    const req = new NextRequest(new URL('https://politypedia.test/teacher/home'));
    req.cookies.set(SESSION_COOKIE, 'garbage');
    expect(location(middleware(req))).toBe('/sign-in');
  });

  it('configures the matcher from the shared string (B7)', () => {
    expect(config.matcher).toEqual([MIDDLEWARE_MATCHER]);
  });
});
