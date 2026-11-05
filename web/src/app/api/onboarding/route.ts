/**
 * POST /api/onboarding  (issue 04-exams-onboarding)
 * Saves the student's picked exams and their language.
 *
 * The browser never holds a Supabase key: this route reads the httpOnly
 * session cookie and calls Supabase with the user's own access token, so
 * Postgres RLS still rejects a write aimed at anybody else's rows.
 *
 * Security: nothing here is logged, and the body that goes back holds no token.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';
import { createSupabaseExamsClient } from '@/lib/exams/supabase-exams-client';
import { isLangMode, type LangMode } from '@/lib/i18n';

/** A student picks from a short list, so this is generous and still bounded. */
const MAX_EXAMS = 20;

export async function POST(request: Request) {
  let examIds: string[] = [];
  let lang: LangMode | null = null;
  try {
    const body = (await request.json()) as { examIds?: unknown; lang?: unknown };
    if (Array.isArray(body.examIds)) {
      // De-duplicated: (user_id, exam_id) is the primary key, so the same id
      // twice in one insert would make Postgres reject the whole batch.
      examIds = [
        ...new Set(
          body.examIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ];
    }
    if (isLangMode(body.lang)) lang = body.lang;
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (lang === null || examIds.length === 0 || examIds.length > MAX_EXAMS) {
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
    await client.saveOnboarding(session, { examIds, lang });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'save failed' }, { status: 502 });
  }
}
