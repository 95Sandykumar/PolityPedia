/**
 * The decision logic behind POST /api/revision/feedback
 * (issue 23-revision-screen).
 *
 * Kept out of the route file so the tests drive it directly, the same split as
 * `revision-route.ts`. The route file is a thin adapter.
 *
 * The order of the checks is the design, and it is the same order as the
 * revision route, so there is one shape to learn:
 *
 *   1. rate limit  -- before ANY database call, so a flood is cheap (C).
 *   2. session     -- no cookie, no vote.
 *   3. body        -- a uuid, one of two languages, one of two thumbs.
 *   4. the write   -- an upsert whose `user_id` comes from `auth.uid()`.
 *
 * Nothing here is the gate. The gate is `ai_feedback_insert_own` in
 * `supabase/migrations/0023_ai_feedback.sql`, which runs under the student's
 * own access token.
 *
 * Security: replies carry a fixed code, never a thrown error. An upstream
 * message can quote a URL or a key.
 */
import type { AuthSession } from '@/lib/auth/types';
import { readFeedbackRequest, type FeedbackClient } from './feedback';
import type { RateLimiter } from './types';

export interface FeedbackInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: FeedbackClient;
  limiter: RateLimiter;
  /** Injected clock, so the rate-limit tests are deterministic. */
  now?: number;
}

/** The codes the screen could switch on. A vote failure is silent in the UI. */
export type FeedbackError =
  | 'rate'
  | 'sign_in'
  | 'bad_request'
  | 'not_configured'
  | 'failed';

export type FeedbackReply =
  | { status: 204; body: null }
  | { status: number; body: { error: FeedbackError } };

function fail(status: number, error: FeedbackError): FeedbackReply {
  return { status, body: { error } };
}

export async function handleFeedback({
  body,
  session,
  client,
  limiter,
  now,
}: FeedbackInput): Promise<FeedbackReply> {
  // Keyed on the user, like the revision route, so one student cannot spend
  // somebody else's allowance by tapping a thumb in a loop.
  const who = session?.userId ?? 'anonymous';
  if (!limiter.take(who, now)) return fail(429, 'rate');

  if (!session) return fail(401, 'sign_in');
  if (!client.isConfigured()) return fail(503, 'not_configured');

  const request = readFeedbackRequest(body);
  if (!request) return fail(400, 'bad_request');

  try {
    await client.save(request);
  } catch {
    // A refused policy, a dead network, a 500: none of it is something the
    // student can fix, and none of it is worth breaking the screen over. The
    // thumb simply does not stay pressed.
    return fail(502, 'failed');
  }

  // 204: there is nothing to read back. The screen already knows which thumb
  // it sent.
  return { status: 204, body: null };
}
