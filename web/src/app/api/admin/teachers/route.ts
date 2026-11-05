/**
 * POST /api/admin/teachers -> approve a teacher
 * (issue 05-teacher-invite-approval).
 *
 * Thin adapter. Every rule lives in `@/lib/teachers/admin-teachers-route`,
 * which the tests drive directly.
 *
 * The Supabase call carries the ADMIN'S OWN access token out of the httpOnly
 * session cookie, so the `teachers_admin_all` policy and the
 * `teachers_block_admin_fields` trigger inside Postgres are the real gate
 * (V19). There is no service-role key in this route.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleAdminTeachers } from '@/lib/teachers/admin-teachers-route';
import { readSessionCookie } from '@/lib/teachers/read-session';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleAdminTeachers` answers 400 for it.
  }

  const reply = await handleAdminTeachers({
    body,
    session,
    client: createSupabaseTeachersClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
