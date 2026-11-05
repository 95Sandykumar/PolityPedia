/**
 * Role guards and the middleware matcher (issue 03-sign-in, design check B7).
 *
 * Pure functions with no Next import, so the middleware config and the test
 * read the same matcher string and can never drift apart.
 */
import type { TeacherStatus } from '@/lib/teachers/types';
import type { Role } from './types';

export type { Role };

/** Rank: admin can do anything a teacher can. */
const RANK: Record<Role, number> = { student: 0, teacher: 1, admin: 2 };

/**
 * Guarded prefixes.
 *
 * `/teacher-signup` is NOT guarded, and must never be: the person opening it
 * is still a student holding an invite code.
 */
export const GUARDED: readonly { prefix: string; role: Role }[] = [
  { prefix: '/teacher', role: 'teacher' },
  { prefix: '/admin', role: 'admin' },
];

/** Where a visitor with no session goes. */
export const SIGN_IN_PATH = '/sign-in';
/** Where a signed-in user with the wrong role goes: Home. */
export const HOME_PATH = '/';
/**
 * The one teacher page a teacher who is not approved yet may see
 * (issue 05-teacher-invite-approval).
 */
export const TEACHER_PENDING_PATH = '/teacher/pending';

export function requiredRole(pathname: string): Role | null {
  for (const { prefix, role } of GUARDED) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return role;
  }
  return null;
}

export type GuardResult = { allow: true } | { allow: false; redirectTo: string };

export function guard({
  pathname,
  role,
  teacherStatus = null,
}: {
  pathname: string;
  role: Role | null;
  /** From the session cookie. Null for anybody who is not a teacher. */
  teacherStatus?: TeacherStatus | null;
}): GuardResult {
  const needed = requiredRole(pathname);
  if (needed === null) return { allow: true };
  if (role === null) return { allow: false, redirectTo: SIGN_IN_PATH };
  if (RANK[role] < RANK[needed]) return { allow: false, redirectTo: HOME_PATH };

  // Issue 05: a teacher must also be APPROVED. A teacher is created pending by
  // `redeem_teacher_invite()`, so the role alone is no longer enough. Fails
  // closed: no status means pending. An admin is not asked for one.
  if (role === 'teacher' && needed === 'teacher' && teacherStatus !== 'approved') {
    if (pathname === TEACHER_PENDING_PATH) return { allow: true };
    return { allow: false, redirectTo: TEACHER_PENDING_PATH };
  }

  return { allow: true };
}

/**
 * B7: the matcher skips `_next/static`, `_next/image` and anything that looks
 * like a file (has an extension), so assets never pay for middleware.
 * `middleware.ts` uses this exact string in its `config.matcher`.
 */
export const MIDDLEWARE_MATCHER = '/((?!_next/static|_next/image|.*\\.[^/]+$).*)';

const MATCHER_RE = new RegExp('^' + MIDDLEWARE_MATCHER + '$');

/** True when the middleware would run for this path. Used by the B7 test. */
export function matchesMiddleware(pathname: string): boolean {
  return MATCHER_RE.test(pathname);
}
