/**
 * POST /api/auth/send-code  (issue 03-sign-in)
 * Asks Supabase to email a 6-digit code. The browser never holds the key.
 *
 * Security: the email is not logged, and the reply is always the same shape,
 * so this route cannot be used to find out which emails exist.
 */
import { NextResponse } from 'next/server';
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
  } catch {
    return NextResponse.json({ error: 'send failed' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
