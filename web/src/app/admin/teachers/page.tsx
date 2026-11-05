/**
 * Admin > Teachers waiting (issue 05-teacher-invite-approval).
 *
 * The list is read HERE, on the server, with the admin's own access token out
 * of the httpOnly session cookie, so Postgres RLS (`teachers_admin_all`) is
 * what decides the rows. The browser never holds a key, and the page never
 * ships a real name of anybody the admin is not allowed to see.
 *
 * The middleware already keeps non-admins out of `/admin/*` (issue 03).
 *
 * The env is read inside the component, never at import time, so the build
 * works with no environment variables (web/CLAUDE.md).
 */
import { cookies } from 'next/headers';
import { AdminTeachersList } from '@/components/admin-teachers-list';
import { readSupabaseEnv } from '@/lib/auth/env';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import type { PendingTeacher } from '@/lib/teachers/types';

export default async function AdminTeachersPage() {
  const configured = readSupabaseEnv() !== null;

  let teachers: PendingTeacher[] = [];
  if (configured) {
    const session = decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
    // No token means no rows: the client returns an empty list, never a crash.
    teachers = await createSupabaseTeachersClient({
      accessToken: session?.accessToken ?? '',
    }).listPending();
  }

  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-4">
      <AdminTeachersList teachers={teachers} configured={configured} />
    </main>
  );
}
