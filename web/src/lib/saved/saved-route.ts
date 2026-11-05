/**
 * The decision logic behind POST /api/saved (issue 14-saved-list).
 *
 * Kept out of the route file so the tests drive it directly, the same split as
 * `follows-route.ts` and `attempts-route.ts`.
 *
 * Order of checks: session, config, then the body. A body is never looked at
 * before we know who is asking.
 *
 * WHO OWNS THE ROW IS NEVER IN THE BODY. It comes from the session token, and
 * `saved_questions_insert_own` re-reads it inside Postgres, so a caller who
 * posts somebody else's id gets a refusal from the database and not from a
 * check done here.
 *
 * ONE ROUTE FOR BOTH DIRECTIONS. `saved: true` saves, `saved: false` removes,
 * so the player, the Mark button and the Saved tab's Remove button all speak
 * one shape and the browser never has to pick a verb.
 *
 * Security: this is defence in depth, not the gate. Replies carry a fixed
 * short word, so a policy name, a constraint name or a Postgres message never
 * reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { readSavedWrite, type SavedClient } from './types';

export interface SavedRouteInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: SavedClient;
}

export interface SavedRouteReply {
  status: number;
  body: { ok: true; saved: boolean } | { error: string };
}

function fail(status: number, error: string): SavedRouteReply {
  return { status, body: { error } };
}

export async function handleSaved({
  body,
  session,
  client,
}: SavedRouteInput): Promise<SavedRouteReply> {
  if (!session) return fail(401, 'sign in');
  if (!client.isConfigured()) return fail(503, 'not configured');

  // Drops a `userId` and anything else that is not one of the three fields.
  const wanted = readSavedWrite(body);
  if (!wanted) return fail(400, 'bad request');

  try {
    if (wanted.saved) await client.save(wanted.questionId, wanted.tag);
    else await client.remove(wanted.questionId, wanted.tag);
  } catch {
    // Fixed message: the thrown error may quote a policy.
    return fail(502, 'save failed');
  }

  // Echo the state back, so the button and the server cannot drift apart.
  return { status: 200, body: { ok: true, saved: wanted.saved } };
}
