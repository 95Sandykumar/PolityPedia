/**
 * The decision logic behind POST /api/follows (issue 06-portfolio-follow).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `admin-teachers-route.ts` / its route.
 *
 * Order of checks: session, then config, then the body.
 *
 * WHO the row belongs to is never in the body. It comes from the session, so
 * there is no field a caller could set to follow on somebody else's behalf.
 * Any `userId` in the body is ignored.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `follows_insert_own` and `follows_delete_own` policies inside Postgres.
 * Replies carry a fixed message, so a policy name never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { FollowsClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FollowsInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: FollowsClient;
}

export interface FollowsReply {
  status: number;
  body: { ok: true; following: boolean } | { error: string };
}

function fail(status: number, error: string): FollowsReply {
  return { status, body: { error } };
}

interface Wanted {
  teacherId: string;
  following: boolean;
}

function readBody(body: unknown): Wanted | null {
  if (typeof body !== 'object' || body === null) return null;
  const { teacherId, following } = body as Record<string, unknown>;
  if (typeof teacherId !== 'string' || !UUID_RE.test(teacherId)) return null;
  // A boolean, not a truthy value: "false" as a string must not read as true.
  if (typeof following !== 'boolean') return null;
  return { teacherId, following };
}

export async function handleFollows({
  body,
  session,
  client,
}: FollowsInput): Promise<FollowsReply> {
  if (!session) return fail(401, 'sign in');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const wanted = readBody(body);
  if (!wanted) return fail(400, 'bad request');

  try {
    if (wanted.following) await client.follow(wanted.teacherId);
    else await client.unfollow(wanted.teacherId);
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  // Echo the state back, so the button and the server cannot drift apart.
  return { status: 200, body: { ok: true, following: wanted.following } };
}
