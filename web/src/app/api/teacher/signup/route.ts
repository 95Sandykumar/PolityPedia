/**
 * POST /api/teacher/signup -> spend an invite code and become a pending teacher
 * (issue 05-teacher-invite-approval).
 *
 * Thin adapter. Every rule lives in `@/lib/teachers/teacher-signup-route`,
 * which the tests drive directly.
 *
 * The Supabase call carries the CALLER'S OWN access token out of the httpOnly
 * session cookie, so the SQL function runs as them and single use is decided
 * by Postgres. There is no service-role key in this route.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { readSessionCookie } from '@/lib/teachers/read-session';
import { createSupabaseTeachersClient } from '@/lib/teachers/supabase-teachers-client';
import { handleTeacherSignup } from '@/lib/teachers/teacher-signup-route';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleTeacherSignup` answers 400 for it.
  }

  const reply = await handleTeacherSignup({
    body,
    session,
    client: createSupabaseTeachersClient({ accessToken: session?.accessToken ?? '' }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
