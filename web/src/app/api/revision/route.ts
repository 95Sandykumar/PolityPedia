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
import { NextResponse, after } from 'next/server';
import { createAnthropicExplainer } from '@/lib/ai/anthropic-explainer';
import { makeExplanationAudio } from '@/lib/ai/explanation-audio';
import { sharedRateLimiter } from '@/lib/ai/rate-limit';
import { handleRevision } from '@/lib/ai/revision-route';
import { createSupabaseAiClient } from '@/lib/ai/supabase-ai-client';
import { createSupabaseAudioClient } from '@/lib/ai/supabase-audio-client';
import { createSupabaseAudioStore } from '@/lib/ai/supabase-audio-store';
import { createUnconfiguredSpeech } from '@/lib/ai/unconfigured-speech';
import { SESSION_COOKIE, decodeSession, type AuthSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
/** A model call is never cached and never statically analysed. */
export const dynamic = 'force-dynamic';

/**
 * How long this function may run (issue 32-ai-claim-tokens).
 *
 * A Claude call with two web searches is slow, and the platform default would
 * kill the function mid-call: the row is then left on `generating` with
 * nobody to finish or fail it, and the student has paid 1 of their 30 for
 * nothing. 60 seconds covers the call, and
 * `claim_ai_explanation()` takes a claim over after 2 minutes
 * (`ai_claim_timeout()`), so even a hard kill costs one retry and no money.
 */
export const maxDuration = 60;

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
  const accessToken = session?.accessToken ?? '';

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Left as null: `handleRevision` answers 400 for it.
  }

  const reply = await handleRevision({
    body,
    session,
    client: createSupabaseAiClient({ accessToken }),
    explainer: createAnthropicExplainer(),
    limiter: sharedRateLimiter(),

    // The background audio step (issue 25-revision-audio).
    //
    // `after()` is why this is a real background step and not a dangling
    // promise: it keeps the function alive past the response, so the student
    // gets their explanation NOW and the voice call runs behind it. A bare
    // `void makeExplanationAudio(...)` would be killed the moment the
    // response is flushed, and the row would be stuck on `making`.
    //
    // `makeExplanationAudio` never throws and never touches the reply, so
    // nothing in here can reach the student. Today the voice provider is
    // unconfigured (X5, human ticket H4), so it stops before it claims
    // anything and the explanation is simply shown with no audio bar.
    audio: (audioRequest, explanationBody) => {
      after(() =>
        makeExplanationAudio({
          request: audioRequest,
          body: explanationBody,
          audio: createSupabaseAudioClient({ accessToken }),
          speech: createUnconfiguredSpeech(),
          store: createSupabaseAudioStore({ accessToken }),
        }),
      );
    },
  });

  return NextResponse.json(reply.body, { status: reply.status });
}
