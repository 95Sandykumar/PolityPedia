/**
 * Browser-side teacher clients (issue 05-teacher-invite-approval).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handlers; those read the caller's access token out of the httpOnly
 * session cookie and let Postgres RLS decide.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import type { AdminTeachersClient, TeacherSignupClient } from './types';

export const TEACHER_SIGNUP_PATH = '/api/teacher/signup';
export const ADMIN_TEACHERS_PATH = '/api/admin/teachers';

async function post(doFetch: typeof fetch, path: string, body: unknown): Promise<void> {
  const res = await doFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Request failed with status ' + res.status);
}

export function createBrowserTeacherSignupClient(fetchImpl?: typeof fetch): TeacherSignupClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);
  return {
    redeem(code: string) {
      return post(doFetch, TEACHER_SIGNUP_PATH, { code });
    },
  };
}

export function createBrowserAdminTeachersClient(fetchImpl?: typeof fetch): AdminTeachersClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);
  return {
    approve(userId: string) {
      return post(doFetch, ADMIN_TEACHERS_PATH, { userId });
    },
  };
}
