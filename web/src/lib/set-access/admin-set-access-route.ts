/**
 * The decision logic behind /api/admin/set-access
 * (issue 16-set-access-mock-list).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `admin-plans-route.ts`. The route file is a thin adapter.
 *
 * Order of checks matters: session, then role, then config, then the body. A
 * visitor who is not an admin gets the same 403 whether or not Supabase is set
 * up, so this route cannot be used to probe the deployment.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `set_access_admin_all` RLS policy inside Postgres, which checks the admin's
 * own access token. Replies carry a fixed message, never a thrown error, so a
 * policy name never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { isUuid, type SetAccessClient } from './types';

/** A hand grant is for testing and support. A year and a bit is plenty. */
const MAX_DAYS_AHEAD = 400;
const DAY_MS = 86_400_000;

export interface AdminSetAccessInput {
  method: 'POST' | 'DELETE';
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: SetAccessClient;
}

export interface AdminSetAccessReply {
  status: number;
  body: { ok: true } | { error: string };
}

function fail(status: number, error: string): AdminSetAccessReply {
  return { status, body: { error } };
}

/** Read the two ids both verbs need. */
function readTarget(body: unknown): { userId: string; setId: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { userId, setId } = body as Record<string, unknown>;
  if (!isUuid(userId) || !isUuid(setId)) return null;
  return { userId, setId };
}

/**
 * A grant also needs a `validUntil` that is in the future and not absurd.
 *
 * A date in the past is REFUSED rather than stored: a row that is already
 * expired looks like access on the admin's screen and is not access at all.
 * Ending a grant is DELETE.
 */
function readValidUntil(body: unknown, now: number): string | null {
  const { validUntil } = body as Record<string, unknown>;
  if (typeof validUntil !== 'string') return null;
  const at = Date.parse(validUntil);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return null;
  if (at > now + MAX_DAYS_AHEAD * DAY_MS) return null;
  return validUntil;
}

export async function handleAdminSetAccess({
  method,
  body,
  session,
  client,
}: AdminSetAccessInput): Promise<AdminSetAccessReply> {
  if (!session) return fail(401, 'sign in');
  if (session.role !== 'admin') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const target = readTarget(body);
  if (!target) return fail(400, 'bad request');

  try {
    if (method === 'POST') {
      const validUntil = readValidUntil(body, Date.now());
      if (!validUntil) return fail(400, 'bad request');
      await client.grant({ ...target, validUntil });
    } else {
      await client.revoke(target);
    }
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  return { status: 200, body: { ok: true } };
}
