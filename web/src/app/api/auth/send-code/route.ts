/**
 * POST /api/auth/send-code  (issue 03-sign-in)
 * Asks Supabase to email a 6-digit code. The browser never holds the key.
 *
 * Security: the email is not logged, and the reply is always the same shape,
 * so this route cannot be used to find out which emails exist.
 */
import { NextResponse } from 'next/server';
import { classifySendFailure } from '@/lib/auth/sign-in-errors';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';

export async function POST(request: Request) {
  let email = '';
  try {
    const body = (await request.json()) as { email?: unknown };
    if (typeof body.email === 'string') email = body.email.trim();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (!email.includes('@')) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  const client = createSupabaseAuthClient();
  if (!client.isConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  try {
    await client.sendEmailCode(email);
  } catch (error) {
    // The rate limit is the same for a known and an unknown email, so telling
    // the student to wait reveals nothing about who has an account.
    const reason = classifySendFailure(error);
    if (reason === 'rate_limited') {
      return NextResponse.json({ error: 'rate limited', reason }, { status: 429 });
    }
    return NextResponse.json({ error: 'send failed', reason }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
