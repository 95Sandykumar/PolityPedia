/**
 * POST /api/auth/verify-code  (issue 03-sign-in)
 * Swaps the emailed code for a session and sets the httpOnly cookie.
 *
 * Security: the code and the tokens never leave this request. Nothing is
 * logged and the body that goes back holds no token.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, encodeSession, sessionCookieOptions } from '@/lib/auth/session';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';

export async function POST(request: Request) {
  let email = '';
  let code = '';
  try {
    const body = (await request.json()) as { email?: unknown; code?: unknown };
    if (typeof body.email === 'string') email = body.email.trim();
    if (typeof body.code === 'string') code = body.code.trim();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (!email.includes('@') || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const client = createSupabaseAuthClient();
  if (!client.isConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  try {
    const session = await client.verifyEmailCode(email, code);
    const response = NextResponse.json({ ok: true, role: session.role });
    response.cookies.set(SESSION_COOKIE, encodeSession(session), sessionCookieOptions());
    return response;
  } catch {
    return NextResponse.json({ error: 'verify failed' }, { status: 401 });
  }
}
