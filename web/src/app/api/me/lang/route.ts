/**
 * POST /api/me/lang  (issue 04-exams-onboarding)
 * Writes `profiles.lang` for the signed-in student, so the language choice
 * follows them to every device.
 *
 * Same shape as /api/onboarding: the browser holds no Supabase key, this route
 * reads the httpOnly session cookie and lets RLS decide the write.
 *
 * Security: nothing here is logged, and the body that goes back holds no token.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { isLangMode } from '@/lib/i18n';

export async function POST(request: Request) {
  let lang: unknown;
  try {
    ({ lang } = (await request.json()) as { lang?: unknown });
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (!isLangMode(lang)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const store = await cookies();
  const session = decodeSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'sign in first' }, { status: 401 });

  const client = createSupabaseExamsClient();
  if (!client.isConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  try {
    await client.saveLang(session, lang);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'save failed' }, { status: 502 });
  }
}
