/**
 * POST /api/follows -> follow or unfollow a teacher
 * (issue 06-portfolio-follow).
 *
 * Thin adapter. Every rule lives in `@/lib/follows/follows-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token and user id out of
 * the httpOnly session cookie, so the `follows_insert_own` and
 * `follows_delete_own` policies inside Postgres are the real gate. There is no
 * service-role key in this route, and the row owner never comes from the body.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { createSupabaseFollowsClient } from '@/lib/follows/supabase-follows-client';
import { handleFollows } from '@/lib/follows/follows-route';
import { readSessionCookie } from '@/lib/teachers/read-session';

export async function POST(request: Request) {
  const session = readSessionCookie(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleFollows` answers 400 for it.
  }

  const reply = await handleFollows({
    body,
    session,
    client: createSupabaseFollowsClient({
      accessToken: session?.accessToken ?? '',
      userId: session?.userId ?? '',
    }),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
