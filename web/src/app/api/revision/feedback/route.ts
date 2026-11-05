/**
 * POST /api/revision/feedback -> thumbs up / down on one AI explanation
 * (issue 23-revision-screen)
 *
 * Body: `{ question_id, lang, vote }` where vote is `up` or `down`. Replies:
 *   204 stored (the screen already knows which thumb it sent)
 *   400 `bad_request`
 *   401 `sign_in`
 *   429 `rate`     -- over 10 requests a minute
 *   502 `failed`
 *   503 `not_configured`
 *
 * Thin adapter. Every rule lives in `@/lib/ai/feedback-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token out of the httpOnly
 * session cookie, and `ai_feedback.user_id` defaults to `auth.uid()`, so the
 * row is stamped inside Postgres and this route cannot write a vote for
 * somebody else. There is no service-role key here.
 *
 * `runtime = 'nodejs'`: the rate limiter is per-instance memory.
 *
 * ITS OWN LIMITER, not the revision route's. They share a limit of 10 a
 * minute per user, and a student tapping thumbs on five explanations must not
 * then be refused the explanation they actually want.
 *
 * Security: nothing here is logged. The cookie holds tokens.
 */
import { NextResponse } from 'next/server';
import { handleFeedback } from '@/lib/ai/feedback-route';
import { createRateLimiter } from '@/lib/ai/rate-limit';
import { createSupabaseFeedbackClient } from '@/lib/ai/supabase-feedback-client';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';
import type { RateLimiter } from '@/lib/ai/types';

export const runtime = 'nodejs';
/** A vote is never cached and never statically analysed. */
export const dynamic = 'force-dynamic';

/**
 * Module scope on purpose: it must survive between requests in the same
 * instance, or it counts nothing. Built lazily, so importing this file does no
 * work at build time.
 */
let limiter: RateLimiter | null = null;

function voteLimiter(): RateLimiter {
  limiter ??= createRateLimiter();
  return limiter;
}

/** Read our one session cookie off the raw header. Never throws. */
function readSession(request: Request): AuthSession | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    return decodeSession(part.slice(at + 1).trim());
  }
  return null;
}

export async function POST(request: Request) {
  const session = readSession(request);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleFeedback` answers 400 for it.
  }

  const reply = await handleFeedback({
    body,
    session,
    client: createSupabaseFeedbackClient({ accessToken: session?.accessToken ?? '' }),
    limiter: voteLimiter(),
  });

  if (reply.status === 204) return new NextResponse(null, { status: 204 });
  return NextResponse.json(reply.body, { status: reply.status });
}
