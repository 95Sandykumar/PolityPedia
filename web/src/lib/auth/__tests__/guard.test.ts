/**
 * Issue 03-sign-in: role guards and the middleware matcher (design check B7).
 * Pure functions, so no Next runtime is needed here.
 */
import { describe, expect, it } from 'vitest';
import { MIDDLEWARE_MATCHER, guard, matchesMiddleware, requiredRole } from '../guard';

describe('requiredRole', () => {
  it('asks for teacher under /teacher', () => {
    expect(requiredRole('/teacher')).toBe('teacher');
    expect(requiredRole('/teacher/home')).toBe('teacher');
    expect(requiredRole('/teacher/papers/7')).toBe('teacher');
  });

  it('asks for admin under /admin', () => {
    expect(requiredRole('/admin')).toBe('admin');
    expect(requiredRole('/admin/teachers')).toBe('admin');
  });

  it('asks for nothing on student pages', () => {
    for (const p of ['/', '/teachers', '/teachers/42', '/practice', '/saved', '/me', '/sign-in']) {
      expect(requiredRole(p)).toBeNull();
    }
  });
});

describe('guard', () => {
  it('sends a student away from a teacher page to Home', () => {
    expect(guard({ pathname: '/teacher/home', role: 'student' })).toEqual({
      allow: false,
      redirectTo: '/',
    });
  });

  it('sends a student away from an admin page to Home', () => {
    expect(guard({ pathname: '/admin/teachers', role: 'student' })).toEqual({
      allow: false,
      redirectTo: '/',
    });
  });

  it('sends a teacher away from an admin page to Home', () => {
    expect(guard({ pathname: '/admin', role: 'teacher' })).toEqual({
      allow: false,
      redirectTo: '/',
    });
  });

  // Issue 05-teacher-invite-approval added the approved check, so a teacher
  // session now carries a status. The pending cases live in
  // src/lib/teachers/__tests__/teacher-approval-guard.test.ts.
  it('lets an approved teacher into a teacher page', () => {
    expect(
      guard({ pathname: '/teacher/home', role: 'teacher', teacherStatus: 'approved' }),
    ).toEqual({ allow: true });
  });

  it('lets an admin into both', () => {
    expect(guard({ pathname: '/teacher/home', role: 'admin' })).toEqual({ allow: true });
    expect(guard({ pathname: '/admin', role: 'admin' })).toEqual({ allow: true });
  });

  it('sends a visitor with no session to the sign-in page', () => {
    expect(guard({ pathname: '/teacher/home', role: null })).toEqual({
      allow: false,
      redirectTo: '/sign-in',
    });
  });

  it('lets anyone through on an unguarded page', () => {
    expect(guard({ pathname: '/', role: null })).toEqual({ allow: true });
    expect(guard({ pathname: '/sign-in', role: null })).toEqual({ allow: true });
  });
});

describe('middleware matcher (B7)', () => {
  it('skips Next static assets and files with an extension', () => {
    const skipped = [
      '/_next/static/x.js',
      '/_next/static/chunks/main-abc123.js',
      '/_next/image',
      '/_next/image/logo.png',
      '/favicon.ico',
      '/robots.txt',
      '/icon-192.png',
      '/fonts/noto.woff2',
    ];
    for (const p of skipped) {
      expect(matchesMiddleware(p), p + ' must be skipped').toBe(false);
    }
  });

  it('still runs on app routes', () => {
    const run = ['/', '/teacher/home', '/admin', '/sign-in', '/teachers/42', '/auth/callback'];
    for (const p of run) {
      expect(matchesMiddleware(p), p + ' must run').toBe(true);
    }
  });

  it('exports the one matcher string the middleware config uses', () => {
    expect(MIDDLEWARE_MATCHER).toContain('_next/static');
    expect(MIDDLEWARE_MATCHER).toContain('_next/image');
  });
});
