/**
 * POST /api/revision -> the AI explanation for one question
 * (issue 22-revision-api)
 *
 * Body: `{ question_id, lang }`. Replies:
 *   200 the explanation (saved or just written)
 *   202 `{ status: 'generating' }` -- somebody's call is in flight, retry
 *   402 `no_plan`  -- show the Rs 100 card
 *   429 `limit`    -- 30 new ones used today; saved ones still work
 *   429 `rate`     -- over 10 requests a minute
 *
 * Thin adapter. Every rule lives in `@/lib/ai/revision-route`, which the
 * tests drive directly.
 *
 * The Supabase call carries the STUDENT'S OWN access token out of the
 * httpOnly session cookie, so `claim_ai_explanation()` inside Postgres is the
 * real gate: the plan, the question visibility and the 30-a-day counter are
 * all decided there, under that student's identity. There is no service-role
 * key in this route.
 *
 * `runtime = 'nodejs'`: the rate limiter is per-instance memory and the
 * Claude key must stay server side.
 *
 * Security: nothing here is logged. The cookie holds tokens and the request
 * body quotes exam text.
 */
import { NextResponse } from 'next/server';
import { createAnthropicExplainer } from '@/lib/ai/anthropic-explainer';
import { sharedRateLimiter } from '@/lib/ai/rate-limit';
import { handleRevision } from '@/lib/ai/revision-route';
import { createSupabaseAiClient } from '@/lib/ai/supabase-ai-client';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
/** A model call is never cached and never statically analysed. */
export const dynamic = 'force-dynamic';

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
    // Left as null: `handleRevision` answers 400 for it.
  }

  const reply = await handleRevision({
    body,
    session,
    client: createSupabaseAiClient({ accessToken: session?.accessToken ?? '' }),
    explainer: createAnthropicExplainer(),
    limiter: sharedRateLimiter(),
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
